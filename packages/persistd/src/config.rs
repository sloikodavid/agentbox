use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::Path,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub exclusions: Vec<String>,
    pub audit: AuditConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditConfig {
    pub max_work_ms_per_tick: u64,
    pub max_filesystem_ops_per_second: u64,
    pub max_hash_bytes_per_second: u64,
    pub directory_batch_size: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            exclusions: vec![
                "/data".into(),
                "/run".into(),
                "/proc".into(),
                "/sys".into(),
                "/dev".into(),
                "/tmp".into(),
                "/var/run".into(),
                "/opt/persistd".into(),
                "/opt/agentbox".into(),
                "/etc/hostname".into(),
                "/etc/hosts".into(),
                "/etc/resolv.conf".into(),
                "/home/user/.local/share/code-server".into(),
            ],
            audit: AuditConfig {
                max_work_ms_per_tick: 10,
                max_filesystem_ops_per_second: 2_000,
                max_hash_bytes_per_second: 20_000_000,
                directory_batch_size: 256,
            },
        }
    }
}

pub fn load_or_create(path: &Path) -> Result<Config> {
    match fs::read(path) {
        Ok(data) => serde_json::from_slice(&data)
            .with_context(|| format!("parse config {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let config = Config::default();
            write(path, &config)?;
            Ok(config)
        }
        Err(error) => Err(error).with_context(|| format!("read config {}", path.display())),
    }
}

fn write(path: &Path, config: &Config) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("config path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .with_context(|| format!("create config dir {}", parent.display()))?;

    let mut data = serde_json::to_vec_pretty(config).context("encode default config")?;
    data.push(b'\n');
    let temp = path.with_extension("json.tmp");
    let _ = fs::remove_file(&temp);
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .with_context(|| format!("create {}", temp.display()))?;
        file.write_all(&data)
            .with_context(|| format!("write {}", temp.display()))?;
        file.sync_all()
            .with_context(|| format!("fsync {}", temp.display()))?;
    }
    fs::rename(&temp, path)
        .with_context(|| format!("publish config {} to {}", temp.display(), path.display()))?;
    let dir = File::open(parent).with_context(|| format!("open {}", parent.display()))?;
    dir.sync_all()
        .with_context(|| format!("fsync {}", parent.display()))
}

#[cfg(test)]
mod tests {
    use super::{Config, load_or_create};

    #[test]
    fn load_or_create_writes_default_config() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("persistd/config.json");

        let config = load_or_create(&path).unwrap();

        assert_eq!(config, Config::default());
        assert!(path.exists());
        let reparsed = load_or_create(&path).unwrap();
        assert_eq!(reparsed, Config::default());
    }
}
