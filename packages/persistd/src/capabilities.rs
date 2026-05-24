#![cfg(unix)]

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
    path::Path,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityReport {
    pub hardlinks: CapabilityState,
    pub xattrs: CapabilityState,
    pub fifos: CapabilityState,
    pub device_nodes: CapabilityState,
    pub sparse_files: CapabilityState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityState {
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl CapabilityState {
    fn supported() -> Self {
        Self {
            supported: true,
            error: None,
        }
    }

    fn unsupported(error: impl ToString) -> Self {
        Self {
            supported: false,
            error: Some(error.to_string()),
        }
    }
}

pub fn probe(volume_dir: &Path) -> Result<CapabilityReport> {
    fs::create_dir_all(volume_dir).with_context(|| format!("create {}", volume_dir.display()))?;
    let probe_dir = volume_dir.join(".internal/capability-probe");
    let _ = fs::remove_dir_all(&probe_dir);
    fs::create_dir_all(&probe_dir).with_context(|| format!("create {}", probe_dir.display()))?;

    let report = CapabilityReport {
        hardlinks: probe_hardlinks(&probe_dir),
        xattrs: probe_xattrs(&probe_dir),
        fifos: probe_fifos(&probe_dir),
        device_nodes: probe_devices(&probe_dir),
        sparse_files: probe_sparse(&probe_dir),
    };
    let _ = fs::remove_dir_all(&probe_dir);
    Ok(report)
}

fn probe_hardlinks(dir: &Path) -> CapabilityState {
    let source = dir.join("hardlink-source");
    let target = dir.join("hardlink-target");
    (|| -> Result<()> {
        fs::write(&source, "x")?;
        fs::hard_link(&source, &target)?;
        let left = fs::metadata(&source)?;
        let right = fs::metadata(&target)?;
        anyhow::ensure!(left.ino() == right.ino(), "hardlink inode mismatch");
        Ok(())
    })()
    .map(|_| CapabilityState::supported())
    .unwrap_or_else(CapabilityState::unsupported)
}

fn probe_xattrs(dir: &Path) -> CapabilityState {
    let path = dir.join("xattr");
    (|| -> Result<()> {
        fs::write(&path, "x")?;
        xattr::set(&path, "user.persistd-probe", b"ok")?;
        anyhow::ensure!(
            xattr::get(&path, "user.persistd-probe")? == Some(b"ok".to_vec()),
            "xattr value mismatch"
        );
        Ok(())
    })()
    .map(|_| CapabilityState::supported())
    .unwrap_or_else(CapabilityState::unsupported)
}

fn probe_fifos(dir: &Path) -> CapabilityState {
    let path = dir.join("fifo");
    (|| -> Result<()> {
        let c = std::ffi::CString::new(path.as_os_str().as_bytes())?;
        let result = unsafe { libc::mkfifo(c.as_ptr(), 0o600) };
        if result != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    })()
    .map(|_| CapabilityState::supported())
    .unwrap_or_else(CapabilityState::unsupported)
}

fn probe_devices(dir: &Path) -> CapabilityState {
    let path = dir.join("null-device");
    (|| -> Result<()> {
        let c = std::ffi::CString::new(path.as_os_str().as_bytes())?;
        let dev = ((1u64 << 8) | 3u64) as libc::dev_t;
        let result = unsafe { libc::mknod(c.as_ptr(), libc::S_IFCHR | 0o600, dev) };
        if result != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    })()
    .map(|_| CapabilityState::supported())
    .unwrap_or_else(CapabilityState::unsupported)
}

fn probe_sparse(dir: &Path) -> CapabilityState {
    let path = dir.join("sparse");
    (|| -> Result<()> {
        let mut file = fs::File::create(&path)?;
        file.write_all(b"a")?;
        file.set_len(16 * 1024 * 1024)?;
        file.write_all(b"z")?;
        drop(file);
        let metadata = fs::metadata(&path)?;
        anyhow::ensure!(
            metadata.blocks() * 512 < metadata.len(),
            "filesystem expanded sparse file"
        );
        Ok(())
    })()
    .map(|_| CapabilityState::supported())
    .unwrap_or_else(CapabilityState::unsupported)
}

#[cfg(test)]
mod tests {
    use super::probe;

    #[test]
    fn probe_reports_volume_capabilities() {
        let temp = tempfile::tempdir().unwrap();
        let report = probe(temp.path()).unwrap();

        assert!(report.hardlinks.supported);
        assert!(report.xattrs.supported);
        assert!(report.fifos.supported);
    }
}
