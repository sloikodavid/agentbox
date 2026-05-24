#![cfg(unix)]

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::{
    ffi::{OsStr, OsString},
    fs,
    os::unix::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

use crate::config::Config;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PublicPath {
    bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct PublicEntry {
    pub path: PublicPath,
    pub full_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodedPath {
    pub display: String,
    pub bytes_b64: String,
}

impl PublicPath {
    pub fn parse(path: &str) -> Result<Self> {
        Self::from_absolute_bytes(path.as_bytes())
    }

    pub fn from_absolute_bytes(path: &[u8]) -> Result<Self> {
        if path.first() != Some(&b'/') {
            bail!("path must be absolute: {}", display_bytes(path));
        }
        if path.contains(&0) {
            bail!("path contains NUL: {}", display_bytes(path));
        }

        let mut normalized = Vec::new();
        for component in path.split(|byte| *byte == b'/') {
            if component.is_empty() || component == b"." {
                continue;
            }
            if component == b".." {
                bail!("path cannot contain '..': {}", display_bytes(path));
            }
            normalized.push(b'/');
            normalized.extend_from_slice(component);
        }

        if normalized.is_empty() {
            bail!("root path cannot be persisted");
        }
        Ok(Self { bytes: normalized })
    }

    pub fn from_root_relative(relative: &Path) -> Result<Self> {
        let bytes = relative.as_os_str().as_bytes();
        if bytes.is_empty() {
            bail!("root path cannot be persisted");
        }
        let mut absolute = Vec::with_capacity(bytes.len() + 1);
        absolute.push(b'/');
        absolute.extend_from_slice(bytes);
        Self::from_absolute_bytes(&absolute)
    }

    pub fn from_encoded(encoded: &EncodedPath) -> Result<Self> {
        let bytes = STANDARD
            .decode(&encoded.bytes_b64)
            .with_context(|| format!("decode path bytes for {}", encoded.display))?;
        Self::from_absolute_bytes(&bytes)
    }

    pub fn from_legacy_display(display: &str) -> Result<Self> {
        Self::parse(display)
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn display(&self) -> String {
        display_bytes(&self.bytes)
    }

    pub fn encoded(&self) -> EncodedPath {
        EncodedPath {
            display: self.display(),
            bytes_b64: STANDARD.encode(&self.bytes),
        }
    }

    pub fn bytes_b64(&self) -> String {
        STANDARD.encode(&self.bytes)
    }

    pub fn relative_os_string(&self) -> OsString {
        OsString::from_vec(self.bytes[1..].to_vec())
    }

    pub fn destination(&self, root: &Path) -> PathBuf {
        root.join(self.relative_os_string())
    }

    pub fn depth(&self) -> usize {
        self.bytes
            .split(|byte| *byte == b'/')
            .filter(|component| !component.is_empty())
            .count()
    }

    pub fn starts_with(&self, other: &PublicPath) -> bool {
        self.bytes == other.bytes
            || (self.bytes.starts_with(&other.bytes)
                && self.bytes.get(other.bytes.len()) == Some(&b'/'))
    }
}

impl std::fmt::Display for PublicPath {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.display())
    }
}

impl AsRef<OsStr> for PublicPath {
    fn as_ref(&self) -> &OsStr {
        OsStr::from_bytes(&self.bytes)
    }
}

pub fn is_excluded(path: &PublicPath, config: &Config) -> bool {
    config
        .exclusions
        .iter()
        .filter_map(|excluded| PublicPath::parse(excluded).ok())
        .any(|excluded| path.starts_with(&excluded))
}

pub fn live_path(root: &Path, public_path: &PublicPath) -> PathBuf {
    public_path.destination(root)
}

pub fn list_public_entries(root: &Path) -> Result<Vec<PublicEntry>> {
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    for entry in WalkDir::new(root).follow_links(false).min_depth(1) {
        let entry = entry?;
        let full_path = entry.path().to_path_buf();
        if is_persistd_temp_path(&full_path) {
            continue;
        }
        let relative = full_path
            .strip_prefix(root)
            .with_context(|| format!("strip public root {}", root.display()))?;
        entries.push(PublicEntry {
            path: PublicPath::from_root_relative(relative)?,
            full_path,
        });
    }
    Ok(entries)
}

pub fn list_public_paths(root: &Path) -> Result<Vec<PublicPath>> {
    Ok(list_public_entries(root)?
        .into_iter()
        .map(|entry| entry.path)
        .collect())
}

pub fn list_public_file_entries(root: &Path) -> Result<Vec<PublicEntry>> {
    Ok(list_public_entries(root)?
        .into_iter()
        .filter(|entry| {
            fs::symlink_metadata(&entry.full_path).is_ok_and(|metadata| !metadata.is_dir())
        })
        .collect())
}

pub fn list_public_file_paths(root: &Path) -> Result<Vec<PublicPath>> {
    Ok(list_public_file_entries(root)?
        .into_iter()
        .map(|entry| entry.path)
        .collect())
}

pub fn ensure_parent(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))
}

pub fn remove_path(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => {
            fs::remove_dir_all(path).with_context(|| format!("remove dir {}", path.display()))?;
        }
        Ok(_) => {
            fs::remove_file(path).with_context(|| format!("remove file {}", path.display()))?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).with_context(|| format!("stat {}", path.display())),
    }
    Ok(())
}

pub fn temp_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("target");
    let hash = blake3::hash(path.as_os_str().as_bytes()).to_hex();
    path.with_file_name(format!(".{file_name}.persistd-tmp-{}", &hash[..16]))
}

pub fn is_persistd_temp_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with('.') && name.contains(".persistd-tmp"))
}

fn display_bytes(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }

    let mut display = String::new();
    for byte in bytes {
        match *byte {
            b'/' => display.push('/'),
            0x20..=0x7e if *byte != b'\\' => display.push(*byte as char),
            _ => display.push_str(&format!("\\x{byte:02x}")),
        }
    }
    display
}

#[cfg(test)]
mod tests {
    use super::PublicPath;
    use std::{
        ffi::OsString,
        os::unix::ffi::{OsStrExt, OsStringExt},
        path::PathBuf,
    };

    #[test]
    fn normalizes_absolute_paths_without_losing_bytes() {
        let path = PublicPath::from_absolute_bytes(b"//space here/./percent%/unicode-\xe2\x98\x83")
            .unwrap();

        assert_eq!(
            path.as_bytes(),
            b"/space here/percent%/unicode-\xe2\x98\x83"
        );
        assert_eq!(path.display(), "/space here/percent%/unicode-\u{2603}");
    }

    #[test]
    fn rejects_root_relative_dotdot_and_nul() {
        assert!(PublicPath::parse("/").is_err());
        assert!(PublicPath::parse("relative").is_err());
        assert!(PublicPath::parse("/a/../b").is_err());
        assert!(PublicPath::from_absolute_bytes(b"/a\0b").is_err());
    }

    #[test]
    fn preserves_non_utf8_path_identity() {
        let relative = PathBuf::from(OsString::from_vec(vec![b'e', 0xff, b'x']));
        let path = PublicPath::from_root_relative(&relative).unwrap();
        let encoded = path.encoded();
        let decoded = PublicPath::from_encoded(&encoded).unwrap();

        assert_eq!(decoded.as_bytes(), b"/e\xffx");
        assert_eq!(decoded.relative_os_string().as_bytes(), b"e\xffx");
        assert_eq!(decoded.display(), "/e\\xffx");
    }

    #[test]
    fn temp_paths_do_not_collide_for_non_utf8_names() {
        let first = PathBuf::from(OsString::from_vec(vec![b'a', 0xff]));
        let second = PathBuf::from(OsString::from_vec(vec![b'b', 0xff]));

        assert_ne!(super::temp_path(&first), super::temp_path(&second));
    }

    #[test]
    fn hashed_temp_paths_are_not_public_truth() {
        let target = PathBuf::from("file");
        let temp = super::temp_path(&target);

        assert!(super::is_persistd_temp_path(&temp));
    }
}
