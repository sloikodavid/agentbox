#![cfg(unix)]

use anyhow::{Context, Result, bail};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::{CString, OsStr},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{FileTypeExt, MetadataExt, PermissionsExt, symlink},
        io::AsRawFd,
    },
    path::Path,
};

use crate::public;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    File,
    Dir,
    Symlink,
    Fifo,
    Socket,
    CharDevice,
    BlockDevice,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XattrRecord {
    pub name: String,
    pub name_bytes_b64: String,
    pub value_b64: String,
}

#[derive(Debug, Clone)]
pub struct FsFacts {
    pub kind: FileKind,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub size: Option<u64>,
    pub mtime_ns: i64,
    pub symlink_target: Option<Vec<u8>>,
    pub rdev_major: Option<u64>,
    pub rdev_minor: Option<u64>,
    pub dev: u64,
    pub ino: u64,
    pub nlink: u64,
    pub xattrs: Vec<XattrRecord>,
}

impl FileKind {
    pub fn from_type(file_type: &std::fs::FileType) -> Self {
        if file_type.is_file() {
            Self::File
        } else if file_type.is_dir() {
            Self::Dir
        } else if file_type.is_symlink() {
            Self::Symlink
        } else if file_type.is_fifo() {
            Self::Fifo
        } else if file_type.is_socket() {
            Self::Socket
        } else if file_type.is_char_device() {
            Self::CharDevice
        } else if file_type.is_block_device() {
            Self::BlockDevice
        } else {
            Self::Unknown
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Dir => "dir",
            Self::Symlink => "symlink",
            Self::Fifo => "fifo",
            Self::Socket => "socket",
            Self::CharDevice => "char_device",
            Self::BlockDevice => "block_device",
            Self::Unknown => "unknown",
        }
    }

    pub fn from_kind_name(kind: &str) -> Self {
        match kind {
            "file" => Self::File,
            "dir" => Self::Dir,
            "symlink" => Self::Symlink,
            "fifo" => Self::Fifo,
            "socket" => Self::Socket,
            "char_device" => Self::CharDevice,
            "block_device" => Self::BlockDevice,
            _ => Self::Unknown,
        }
    }
}

pub fn facts(path: &Path) -> Result<FsFacts> {
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("stat {}", path.display()))?;
    let file_type = metadata.file_type();
    let kind = FileKind::from_type(&file_type);
    let symlink_target = if matches!(kind, FileKind::Symlink) {
        Some(fs::read_link(path)?.as_os_str().as_bytes().to_vec())
    } else {
        None
    };
    let (rdev_major, rdev_minor) = device_numbers(&metadata, &kind);

    Ok(FsFacts {
        kind,
        mode: metadata.mode(),
        uid: metadata.uid(),
        gid: metadata.gid(),
        size: if file_type.is_file() {
            Some(metadata.len())
        } else {
            None
        },
        mtime_ns: metadata.mtime() * 1_000_000_000 + metadata.mtime_nsec(),
        symlink_target,
        rdev_major,
        rdev_minor,
        dev: metadata.dev(),
        ino: metadata.ino(),
        nlink: metadata.nlink(),
        xattrs: read_xattrs(path)?,
    })
}

pub fn hash_file(path: &Path) -> Result<String> {
    let mut file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut hasher = blake3::Hasher::new();
    hasher
        .update_reader(&mut file)
        .with_context(|| format!("hash {}", path.display()))?;
    Ok(hasher.finalize().to_hex().to_string())
}

pub fn copy_entry_atomic(source: &Path, destination: &Path) -> Result<()> {
    copy_entry_atomic_inner(source, destination, true)
}

pub fn copy_entry_atomic_without_xattrs(source: &Path, destination: &Path) -> Result<()> {
    copy_entry_atomic_inner(source, destination, false)
}

pub fn is_xattr_error(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        let text = cause.to_string();
        text.contains("xattr") || text.contains("extended attribute")
    })
}

fn copy_entry_atomic_inner(source: &Path, destination: &Path, apply_xattrs: bool) -> Result<()> {
    let source_facts = facts(source)?;
    public::ensure_parent(destination)?;
    public::remove_path(destination)?;

    match source_facts.kind {
        FileKind::File => copy_regular_stable(source, destination)?,
        FileKind::Dir => fs::create_dir_all(destination)
            .with_context(|| format!("create dir {}", destination.display()))?,
        FileKind::Symlink => {
            let target = source_facts
                .symlink_target
                .as_ref()
                .context("symlink missing target")?;
            symlink_atomic(OsStr::from_bytes(target), destination)?;
        }
        FileKind::Fifo => make_fifo(destination, source_facts.mode)?,
        FileKind::CharDevice | FileKind::BlockDevice => {
            make_device(destination, &source_facts)?;
        }
        FileKind::Socket => bail!("refusing to persist live socket {}", source.display()),
        FileKind::Unknown => bail!("unsupported file type at {}", source.display()),
    }

    if apply_xattrs {
        apply_facts(destination, &source_facts)?;
    } else {
        let mut facts_without_xattrs = source_facts;
        facts_without_xattrs.xattrs.clear();
        apply_facts(destination, &facts_without_xattrs)?;
    }
    fsync_parent(destination)?;
    Ok(())
}

pub fn copy_metadata(source: &Path, destination: &Path) -> Result<()> {
    let source_facts = facts(source)?;
    apply_facts(destination, &source_facts)
}

pub fn apply_facts(path: &Path, source: &FsFacts) -> Result<()> {
    if let (Some(_), Some(_)) = (source.rdev_major, source.rdev_minor) {
        // Device identity is handled at creation time.
    }

    lchown(path, source.uid, source.gid)?;

    let target_metadata =
        fs::symlink_metadata(path).with_context(|| format!("stat {}", path.display()))?;
    let is_symlink = target_metadata.file_type().is_symlink();
    if !is_symlink {
        fs::set_permissions(path, fs::Permissions::from_mode(source.mode))
            .with_context(|| format!("chmod {}", path.display()))?;
    }

    set_times_no_follow(path, source.mtime_ns)
        .with_context(|| format!("set times {}", path.display()))?;

    apply_xattrs(path, &source.xattrs)?;
    Ok(())
}

pub fn apply_xattrs(path: &Path, xattrs: &[XattrRecord]) -> Result<()> {
    let desired = xattrs
        .iter()
        .map(|record| Ok((decode_b64(&record.name_bytes_b64)?, record)))
        .collect::<Result<BTreeMap<Vec<u8>, &XattrRecord>>>()?;

    if let Ok(existing) = xattr::list(path) {
        for name in existing {
            let name_bytes = name.as_bytes().to_vec();
            if !desired.contains_key(&name_bytes) {
                let _ = xattr::remove(path, &name);
            }
        }
    }

    for (name_bytes, record) in desired {
        let value = decode_b64(&record.value_b64)?;
        xattr::set(path, OsStr::from_bytes(&name_bytes), &value)
            .with_context(|| format!("set xattr {} on {}", record.name, path.display()))?;
    }
    Ok(())
}

pub fn ensure_safe_parent(root: &Path, target: &Path) -> Result<()> {
    let parent = target
        .parent()
        .with_context(|| format!("target has no parent: {}", target.display()))?;
    let relative = parent
        .strip_prefix(root)
        .with_context(|| format!("target escaped root: {}", target.display()))?;

    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                bail!(
                    "refusing to apply through symlink ancestor {}",
                    current.display()
                );
            }
            Ok(metadata) if !metadata.file_type().is_dir() => {
                bail!("ancestor is not a directory: {}", current.display());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current)
                    .with_context(|| format!("create {}", current.display()))?;
            }
            Err(error) => return Err(error).with_context(|| format!("stat {}", current.display())),
        }
    }
    Ok(())
}

pub fn make_hardlink(source: &Path, target: &Path) -> Result<()> {
    public::ensure_parent(target)?;
    public::remove_path(target)?;
    fs::hard_link(source, target)
        .with_context(|| format!("hardlink {} to {}", source.display(), target.display()))?;
    fsync_parent(target)
}

pub fn fsync_parent(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("path has no parent: {}", path.display()))?;
    let dir = File::open(parent).with_context(|| format!("open {}", parent.display()))?;
    dir.sync_all()
        .with_context(|| format!("fsync {}", parent.display()))
}

fn copy_regular_stable(source: &Path, destination: &Path) -> Result<()> {
    let mut last_error = None;
    for _ in 0..3 {
        let before =
            fs::symlink_metadata(source).with_context(|| format!("stat {}", source.display()))?;
        copy_regular_once(source, destination)?;
        let after =
            fs::symlink_metadata(source).with_context(|| format!("stat {}", source.display()))?;
        if before.ino() == after.ino()
            && before.dev() == after.dev()
            && before.len() == after.len()
            && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec()
        {
            return Ok(());
        }
        last_error = Some(anyhow::anyhow!(
            "source changed while copying {}",
            source.display()
        ));
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("copy retry failed")))
}

fn copy_regular_once(source: &Path, destination: &Path) -> Result<()> {
    let temp = public::temp_path(destination);
    let _ = fs::remove_file(&temp);
    {
        let mut input = File::open(source).with_context(|| format!("open {}", source.display()))?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .with_context(|| format!("create {}", temp.display()))?;
        copy_sparse(&mut input, &mut output)
            .with_context(|| format!("copy {} to {}", source.display(), temp.display()))?;
        output
            .sync_all()
            .with_context(|| format!("fsync {}", temp.display()))?;
    }
    fs::rename(&temp, destination)
        .with_context(|| format!("publish {} to {}", temp.display(), destination.display()))?;
    fsync_parent(destination)
}

fn copy_sparse(input: &mut File, output: &mut File) -> Result<()> {
    let size = input.metadata()?.len();
    output.set_len(size)?;
    if size == 0 {
        return Ok(());
    }

    let input_fd = input.as_raw_fd();
    let mut offset: libc::off_t = 0;
    while (offset as u64) < size {
        let data = unsafe { libc::lseek(input_fd, offset, libc::SEEK_DATA) };
        if data < 0 {
            let error = std::io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(libc::ENXIO) => Ok(()),
                Some(libc::EINVAL) => copy_dense(input, output, size),
                _ => Err(error).context("seek data"),
            };
        }

        let hole = unsafe { libc::lseek(input_fd, data, libc::SEEK_HOLE) };
        if hole < 0 {
            let error = std::io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(libc::EINVAL) => copy_dense(input, output, size),
                _ => Err(error).context("seek hole"),
            };
        }

        copy_range(input, output, data as u64, (hole - data) as u64)?;
        offset = hole;
    }
    Ok(())
}

fn copy_dense(input: &mut File, output: &mut File, size: u64) -> Result<()> {
    input.seek(SeekFrom::Start(0))?;
    output.seek(SeekFrom::Start(0))?;
    std::io::copy(input, output)?;
    output.set_len(size)?;
    Ok(())
}

fn copy_range(input: &mut File, output: &mut File, start: u64, len: u64) -> Result<()> {
    input.seek(SeekFrom::Start(start))?;
    output.seek(SeekFrom::Start(start))?;
    let mut remaining = len;
    let mut buffer = vec![0; 1024 * 1024];
    while remaining > 0 {
        let limit = remaining.min(buffer.len() as u64) as usize;
        let read = input.read(&mut buffer[..limit])?;
        if read == 0 {
            bail!("source ended while copying sparse range");
        }
        output.write_all(&buffer[..read])?;
        remaining -= read as u64;
    }
    Ok(())
}

fn symlink_atomic(target: &OsStr, destination: &Path) -> Result<()> {
    let temp = public::temp_path(destination);
    let _ = fs::remove_file(&temp);
    symlink(target, &temp).with_context(|| format!("symlink {}", temp.display()))?;
    fs::rename(&temp, destination)
        .with_context(|| format!("publish {} to {}", temp.display(), destination.display()))
}

fn make_fifo(path: &Path, mode: u32) -> Result<()> {
    let c_path = c_path(path)?;
    let result = unsafe { libc::mkfifo(c_path.as_ptr(), mode as libc::mode_t) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error()).with_context(|| format!("mkfifo {}", path.display()))
    }
}

fn make_device(path: &Path, facts: &FsFacts) -> Result<()> {
    let (Some(major), Some(minor)) = (facts.rdev_major, facts.rdev_minor) else {
        bail!("device record missing major/minor for {}", path.display());
    };
    let c_path = c_path(path)?;
    let kind = match facts.kind {
        FileKind::CharDevice => libc::S_IFCHR,
        FileKind::BlockDevice => libc::S_IFBLK,
        _ => bail!("not a device kind for {}", path.display()),
    };
    let mode = kind | (facts.mode as libc::mode_t & 0o7777);
    let result = unsafe { libc::mknod(c_path.as_ptr(), mode, make_dev(major, minor)) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error()).with_context(|| format!("mknod {}", path.display()))
    }
}

fn lchown(path: &Path, uid: u32, gid: u32) -> Result<()> {
    let c_path = c_path(path)?;
    let result = unsafe { libc::lchown(c_path.as_ptr(), uid, gid) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error()).with_context(|| format!("lchown {}", path.display()))
    }
}

fn c_path(path: &Path) -> Result<CString> {
    CString::new(path.as_os_str().as_bytes())
        .with_context(|| format!("path contains NUL: {}", path.display()))
}

fn set_times_no_follow(path: &Path, ns: i64) -> Result<()> {
    let c_path = c_path(path)?;
    let seconds = ns.div_euclid(1_000_000_000);
    let nanos = ns.rem_euclid(1_000_000_000);
    let times = [
        libc::timespec {
            tv_sec: seconds as libc::time_t,
            tv_nsec: nanos as libc::c_long,
        },
        libc::timespec {
            tv_sec: seconds as libc::time_t,
            tv_nsec: nanos as libc::c_long,
        },
    ];
    let result = unsafe {
        libc::utimensat(
            libc::AT_FDCWD,
            c_path.as_ptr(),
            times.as_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error()).context("utimensat")
    }
}

#[allow(dead_code)]
fn file_time_from_ns(ns: i64) -> (i64, u32) {
    let seconds = ns.div_euclid(1_000_000_000);
    let nanos = ns.rem_euclid(1_000_000_000) as u32;
    (seconds, nanos)
}

fn read_xattrs(path: &Path) -> Result<Vec<XattrRecord>> {
    let mut records = Vec::new();
    let names = match xattr::list(path) {
        Ok(names) => names,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::Unsupported | std::io::ErrorKind::InvalidInput
            ) =>
        {
            return Ok(records);
        }
        Err(error) => return Err(error).with_context(|| format!("list xattrs {}", path.display())),
    };

    for name in names {
        let Some(value) = xattr::get(path, &name)
            .with_context(|| format!("get xattr {:?} from {}", name, path.display()))?
        else {
            continue;
        };
        let name_bytes = name.as_bytes();
        records.push(XattrRecord {
            name: display_xattr_name(name_bytes),
            name_bytes_b64: encode_b64(name_bytes),
            value_b64: encode_b64(&value),
        });
    }
    records.sort_by(|left, right| left.name_bytes_b64.cmp(&right.name_bytes_b64));
    Ok(records)
}

fn encode_b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn decode_b64(text: &str) -> Result<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .context("decode base64")
}

fn display_xattr_name(bytes: &[u8]) -> String {
    std::str::from_utf8(bytes)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|_| encode_b64(bytes))
}

fn device_numbers(metadata: &fs::Metadata, kind: &FileKind) -> (Option<u64>, Option<u64>) {
    if !matches!(kind, FileKind::CharDevice | FileKind::BlockDevice) {
        return (None, None);
    }

    let rdev = metadata.rdev();
    let major = ((rdev >> 8) & 0xfff) | ((rdev >> 32) & !0xfff);
    let minor = (rdev & 0xff) | ((rdev >> 12) & !0xff);
    (Some(major), Some(minor))
}

fn make_dev(major: u64, minor: u64) -> libc::dev_t {
    (((major & 0xffff_f000) << 32)
        | ((major & 0x0000_0fff) << 8)
        | ((minor & 0xffff_ff00) << 12)
        | (minor & 0x0000_00ff)) as libc::dev_t
}

#[cfg(test)]
mod tests {
    use super::{FileKind, copy_entry_atomic, facts, make_hardlink};
    use std::{
        fs,
        io::Write,
        os::unix::{
            ffi::OsStrExt,
            fs::{PermissionsExt, symlink},
        },
        process::Command,
    };

    #[test]
    fn copies_regular_file_metadata_and_xattrs() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let dest = temp.path().join("dest");
        fs::write(&source, "hello").unwrap();
        xattr::set(&source, "user.persistd-test", b"value").unwrap();

        copy_entry_atomic(&source, &dest).unwrap();

        assert_eq!(fs::read_to_string(&dest).unwrap(), "hello");
        assert_eq!(
            xattr::get(&dest, "user.persistd-test").unwrap(),
            Some(b"value".to_vec())
        );
    }

    #[test]
    fn copies_file_capabilities_when_supported() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("cap-source");
        let dest = temp.path().join("cap-dest");
        fs::write(&source, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();

        let setcap = Command::new("setcap")
            .arg("cap_net_bind_service=+ep")
            .arg(&source)
            .status();
        if !setcap.is_ok_and(|status| status.success()) {
            eprintln!("skipping capability copy test: setcap unavailable or not permitted");
            return;
        }

        copy_entry_atomic(&source, &dest).unwrap();

        let output = Command::new("getcap").arg(&dest).output();
        let Ok(output) = output else {
            eprintln!("skipping capability copy test: getcap unavailable");
            return;
        };
        if !output.status.success() {
            eprintln!("skipping capability copy test: getcap failed");
            return;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("cap_net_bind_service"));
    }

    #[test]
    fn preserves_sparse_file_holes_when_supported() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("sparse");
        let dest = temp.path().join("dest");
        let mut file = fs::File::create(&source).unwrap();
        file.write_all(b"head").unwrap();
        file.set_len(16 * 1024 * 1024).unwrap();
        file.write_all(b"tail").unwrap();
        drop(file);

        copy_entry_atomic(&source, &dest).unwrap();

        assert_eq!(
            fs::metadata(&dest).unwrap().len(),
            fs::metadata(&source).unwrap().len()
        );
        assert_eq!(fs::read(&dest).unwrap()[..4], b"head"[..]);
    }

    #[test]
    fn copies_symlink_and_fifo() {
        let temp = tempfile::tempdir().unwrap();
        let link = temp.path().join("link");
        let link_dest = temp.path().join("link-dest");
        symlink("/target", &link).unwrap();

        copy_entry_atomic(&link, &link_dest).unwrap();
        assert_eq!(
            fs::read_link(&link_dest).unwrap(),
            std::path::PathBuf::from("/target")
        );

        let fifo = temp.path().join("fifo");
        let fifo_dest = temp.path().join("fifo-dest");
        unsafe {
            let c = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
            assert_eq!(libc::mkfifo(c.as_ptr(), 0o644), 0);
        }

        copy_entry_atomic(&fifo, &fifo_dest).unwrap();
        assert_eq!(facts(&fifo_dest).unwrap().kind, FileKind::Fifo);
    }

    #[test]
    fn creates_hardlink() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        fs::write(&source, "same").unwrap();

        make_hardlink(&source, &target).unwrap();

        assert_eq!(facts(&source).unwrap().ino, facts(&target).unwrap().ino);
    }
}
