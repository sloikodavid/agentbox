#![cfg(unix)]
#![allow(dead_code)]

use anyhow::{Context, Result};
use std::{collections::BTreeMap, fs, path::Path};

use crate::{
    config::Config,
    metadata::{self, MetadataRecord},
    paths::Paths,
    public::{self, PublicPath},
    rootfs::{self, FileKind, FsFacts},
};

pub fn apply_public_truth(root: &Path, paths: &Paths, config: &Config) -> Result<()> {
    apply_removed(root, paths, config)?;
    apply_changed(root, paths, config)?;
    apply_metadata(root, paths, config)?;
    apply_hardlinks(root, paths, config)?;
    Ok(())
}

fn apply_removed(root: &Path, paths: &Paths, config: &Config) -> Result<()> {
    let mut markers = public::list_public_file_paths(&paths.removed_dir)?;
    markers.sort_by_key(|path| std::cmp::Reverse(path.depth()));

    for public_path in markers {
        if public::is_excluded(&public_path, config) {
            continue;
        }
        public::remove_path(&public::live_path(root, &public_path))?;
    }
    Ok(())
}

fn apply_changed(root: &Path, paths: &Paths, config: &Config) -> Result<()> {
    let mut entries = public::list_public_entries(&paths.changed_dir)?;
    entries.sort_by_key(|entry| entry.path.depth());

    for entry in entries {
        if public::is_excluded(&entry.path, config) {
            continue;
        }
        apply_changed_entry(root, &entry.path, &entry.full_path)?;
    }
    Ok(())
}

fn apply_metadata(root: &Path, paths: &Paths, config: &Config) -> Result<()> {
    let records = metadata::compact(&paths.metadata_file)?;
    for record in records {
        let public_path = record.public_path()?;
        if public::is_excluded(&public_path, config) {
            continue;
        }
        let target = public::live_path(root, &public_path);
        apply_metadata_record(&target, &record)?;
    }
    Ok(())
}

fn apply_changed_entry(root: &Path, public_path: &PublicPath, changed_path: &Path) -> Result<()> {
    let target = public::live_path(root, public_path);
    let source_facts =
        rootfs::facts(changed_path).with_context(|| format!("stat {}", changed_path.display()))?;

    rootfs::ensure_safe_parent(root, &target)?;

    if matches!(source_facts.kind, FileKind::Dir) {
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(metadata) if metadata.file_type().is_symlink() => {
                anyhow::bail!("refusing to replace symlink ancestor {}", target.display());
            }
            Ok(_) => {
                public::remove_path(&target)?;
                fs::create_dir_all(&target)
                    .with_context(|| format!("create {}", target.display()))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir_all(&target)
                    .with_context(|| format!("create {}", target.display()))?;
            }
            Err(error) => return Err(error).with_context(|| format!("stat {}", target.display())),
        }
        rootfs::apply_facts(&target, &source_facts)?;
    } else {
        rootfs::copy_entry_atomic(changed_path, &target)?;
    }
    Ok(())
}

fn apply_metadata_record(target: &Path, record: &MetadataRecord) -> Result<()> {
    if fs::symlink_metadata(target).is_err() {
        create_fallback_target(target, record)?;
    }

    if let Ok(mut facts) = rootfs::facts(target) {
        if let Some(mode) = record.mode {
            facts.mode = mode;
        }
        if let Some(uid) = record.uid {
            facts.uid = uid;
        }
        if let Some(gid) = record.gid {
            facts.gid = gid;
        }
        if let Some(mtime_ns) = record.mtime_ns {
            facts.mtime_ns = mtime_ns;
        }
        if let Some(xattrs) = &record.xattrs {
            facts.xattrs = xattrs.clone();
        }
        rootfs::apply_facts(target, &facts)?;
    }
    Ok(())
}

fn create_fallback_target(target: &Path, record: &MetadataRecord) -> Result<()> {
    public::ensure_parent(target)?;
    let facts = FsFacts {
        kind: FileKind::from_kind_name(&record.kind),
        mode: record.mode.unwrap_or(0o644),
        uid: record.uid.unwrap_or(0),
        gid: record.gid.unwrap_or(0),
        size: None,
        mtime_ns: record.mtime_ns.unwrap_or(0),
        symlink_target: None,
        rdev_major: record.rdev_major,
        rdev_minor: record.rdev_minor,
        dev: 0,
        ino: 0,
        nlink: 1,
        xattrs: record.xattrs.clone().unwrap_or_default(),
    };

    match facts.kind {
        FileKind::Fifo | FileKind::CharDevice | FileKind::BlockDevice => {
            let temp = tempfile_like_source(target, &facts)?;
            rootfs::copy_entry_atomic(&temp, target)?;
            public::remove_path(&temp)?;
        }
        _ => {}
    }
    Ok(())
}

fn tempfile_like_source(target: &Path, facts: &FsFacts) -> Result<std::path::PathBuf> {
    let temp = public::temp_path(target);
    public::remove_path(&temp)?;
    match facts.kind {
        FileKind::Fifo => {
            let c = std::ffi::CString::new(temp.as_os_str().as_encoded_bytes())?;
            let result = unsafe { libc::mkfifo(c.as_ptr(), facts.mode as libc::mode_t) };
            if result != 0 {
                return Err(std::io::Error::last_os_error()).context("mkfifo fallback");
            }
        }
        FileKind::CharDevice | FileKind::BlockDevice => {
            let c = std::ffi::CString::new(temp.as_os_str().as_encoded_bytes())?;
            let mode = match facts.kind {
                FileKind::CharDevice => libc::S_IFCHR,
                FileKind::BlockDevice => libc::S_IFBLK,
                _ => unreachable!(),
            } | (facts.mode as libc::mode_t & 0o7777);
            let dev = make_dev(facts.rdev_major.unwrap_or(0), facts.rdev_minor.unwrap_or(0));
            let result = unsafe { libc::mknod(c.as_ptr(), mode, dev) };
            if result != 0 {
                return Err(std::io::Error::last_os_error()).context("mknod fallback");
            }
        }
        _ => {}
    }
    Ok(temp)
}

fn apply_hardlinks(root: &Path, paths: &Paths, config: &Config) -> Result<()> {
    let mut groups: BTreeMap<String, Vec<PublicPath>> = BTreeMap::new();
    for record in metadata::load(&paths.metadata_file)? {
        let Some(key) = record.hardlink_key.clone() else {
            continue;
        };
        let public_path = record.public_path()?;
        if public::is_excluded(&public_path, config) {
            continue;
        }
        groups.entry(key).or_default().push(public_path);
    }

    for paths in groups.into_values() {
        let mut existing = paths
            .iter()
            .map(|path| public::live_path(root, path))
            .filter(|path| path.exists())
            .collect::<Vec<_>>();
        existing.sort();
        let Some(source) = existing.first().cloned() else {
            continue;
        };
        for target in existing.into_iter().skip(1) {
            let source_facts = rootfs::facts(&source)?;
            let target_facts = rootfs::facts(&target)?;
            if source_facts.dev == target_facts.dev && source_facts.ino == target_facts.ino {
                continue;
            }
            rootfs::make_hardlink(&source, &target)?;
        }
    }
    Ok(())
}

fn make_dev(major: u64, minor: u64) -> libc::dev_t {
    (((major & 0xffff_f000) << 32)
        | ((major & 0x0000_0fff) << 8)
        | ((minor & 0xffff_ff00) << 12)
        | (minor & 0x0000_00ff)) as libc::dev_t
}

#[cfg(test)]
mod tests {
    use super::apply_public_truth;
    use crate::{
        config::Config,
        layout,
        metadata::{self, MetadataRecord},
        paths::Paths,
        public::PublicPath,
    };
    use std::{fs, os::unix::fs::symlink};

    #[test]
    fn apply_removes_then_restores_changed_file_so_changed_wins() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("etc/conf"), "image").unwrap();
        fs::create_dir_all(fixture.paths.removed_dir.join("etc")).unwrap();
        fs::write(fixture.paths.removed_dir.join("etc/conf"), "").unwrap();
        fs::create_dir_all(fixture.paths.changed_dir.join("etc")).unwrap();
        fs::write(fixture.paths.changed_dir.join("etc/conf"), "changed").unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert_eq!(
            fs::read_to_string(fixture.root.join("etc/conf")).unwrap(),
            "changed"
        );
    }

    #[test]
    fn apply_removes_deleted_image_path() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("remove-me"), "image").unwrap();
        fs::write(fixture.paths.removed_dir.join("remove-me"), "").unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert!(!fixture.root.join("remove-me").exists());
    }

    #[test]
    fn apply_treats_only_removed_files_as_tombstones() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.root.join("usr/bin")).unwrap();
        fs::create_dir_all(fixture.root.join("usr/share/applications")).unwrap();
        fs::write(fixture.root.join("usr/bin/supervisord"), "supervisor").unwrap();
        fs::write(
            fixture.root.join("usr/share/applications/agentbox.desktop"),
            "desktop",
        )
        .unwrap();
        fs::create_dir_all(fixture.paths.removed_dir.join("usr/share/applications")).unwrap();
        fs::write(
            fixture
                .paths
                .removed_dir
                .join("usr/share/applications/agentbox.desktop"),
            "",
        )
        .unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert!(fixture.root.join("usr/bin/supervisord").exists());
        assert!(
            !fixture
                .root
                .join("usr/share/applications/agentbox.desktop")
                .exists()
        );
    }

    #[test]
    fn apply_restores_changed_directory_file_and_symlink() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.changed_dir.join("dir")).unwrap();
        fs::write(fixture.paths.changed_dir.join("dir/file"), "file").unwrap();
        symlink("/dir/file", fixture.paths.changed_dir.join("link")).unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert_eq!(
            fs::read_to_string(fixture.root.join("dir/file")).unwrap(),
            "file"
        );
        assert_eq!(
            fs::read_link(fixture.root.join("link")).unwrap(),
            std::path::PathBuf::from("/dir/file")
        );
    }

    #[test]
    fn apply_metadata_sets_mode_mtime_and_xattr() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("file"), "file").unwrap();
        let public_path = PublicPath::parse("/file").unwrap();
        let mut record = MetadataRecord {
            version: 1,
            path: String::new(),
            path_bytes_b64: None,
            kind: "file".into(),
            mode: Some(0o600),
            uid: None,
            gid: None,
            mtime_ns: Some(42_000_000_123),
            symlink_target: None,
            symlink_target_bytes_b64: None,
            rdev_major: None,
            rdev_minor: None,
            hardlink_key: None,
            xattrs: Some(vec![crate::rootfs::XattrRecord {
                name: "user.persistd-test".into(),
                name_bytes_b64: {
                    use base64::Engine as _;
                    base64::engine::general_purpose::STANDARD.encode("user.persistd-test")
                },
                value_b64: {
                    use base64::Engine as _;
                    base64::engine::general_purpose::STANDARD.encode("value")
                },
            }]),
            acl: None,
            capability: None,
        };
        record.set_public_path(&public_path);
        metadata::upsert(&fixture.paths.metadata_file, record).unwrap();

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        let metadata = fs::metadata(fixture.root.join("file")).unwrap();
        assert_eq!(
            std::os::unix::fs::PermissionsExt::mode(&metadata.permissions()) & 0o777,
            0o600
        );
        assert_eq!(std::os::unix::fs::MetadataExt::mtime(&metadata), 42);
        assert_eq!(std::os::unix::fs::MetadataExt::mtime_nsec(&metadata), 123);
        assert_eq!(
            xattr::get(fixture.root.join("file"), "user.persistd-test").unwrap(),
            Some(b"value".to_vec())
        );
    }

    #[test]
    fn apply_refuses_symlink_ancestor_escape() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.changed_dir.join("safe/link")).unwrap();
        fs::write(fixture.paths.changed_dir.join("safe/link/file"), "nope").unwrap();
        fs::create_dir_all(fixture.root.join("safe")).unwrap();
        symlink("/tmp", fixture.root.join("safe/link")).unwrap();

        let error = apply_public_truth(&fixture.root, &fixture.paths, &Config::default())
            .unwrap_err()
            .to_string();

        assert!(error.contains("symlink ancestor"));
    }

    #[test]
    fn apply_relinks_hardlink_groups_from_metadata() {
        let fixture = Fixture::new();
        fs::write(fixture.paths.changed_dir.join("a"), "same").unwrap();
        fs::write(fixture.paths.changed_dir.join("b"), "same").unwrap();
        for name in ["/a", "/b"] {
            let public_path = PublicPath::parse(name).unwrap();
            let mut record = MetadataRecord {
                version: 1,
                path: String::new(),
                path_bytes_b64: None,
                kind: "file".into(),
                mode: None,
                uid: None,
                gid: None,
                mtime_ns: None,
                symlink_target: None,
                symlink_target_bytes_b64: None,
                rdev_major: None,
                rdev_minor: None,
                hardlink_key: Some("1:2".into()),
                xattrs: None,
                acl: None,
                capability: None,
            };
            record.set_public_path(&public_path);
            metadata::upsert(&fixture.paths.metadata_file, record).unwrap();
        }

        apply_public_truth(&fixture.root, &fixture.paths, &Config::default()).unwrap();

        assert_eq!(
            crate::rootfs::facts(&fixture.root.join("a")).unwrap().ino,
            crate::rootfs::facts(&fixture.root.join("b")).unwrap().ino
        );
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        root: std::path::PathBuf,
        paths: Paths,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("root");
            let paths = Paths::new(
                root.join("opt/persistd"),
                temp.path().join("run/persistd"),
                temp.path().join("data/persistd"),
            );
            fs::create_dir_all(root.join("etc")).unwrap();
            layout::ensure(&paths).unwrap();
            Self {
                _temp: temp,
                root,
                paths,
            }
        }
    }
}
