use anyhow::{Context, Result};
use std::fs;

use crate::{config, paths::Paths};

pub fn ensure(paths: &Paths) -> Result<()> {
    fs::create_dir_all(&paths.data_dir)
        .with_context(|| format!("create {}", paths.data_dir.display()))?;
    fs::create_dir_all(&paths.changed_dir)
        .with_context(|| format!("create {}", paths.changed_dir.display()))?;
    fs::create_dir_all(&paths.removed_dir)
        .with_context(|| format!("create {}", paths.removed_dir.display()))?;
    fs::create_dir_all(&paths.internal_dir)
        .with_context(|| format!("create {}", paths.internal_dir.display()))?;
    fs::create_dir_all(&paths.run_dir)
        .with_context(|| format!("create {}", paths.run_dir.display()))?;

    config::load_or_create(&paths.config_file)?;
    ensure_file(&paths.metadata_file)?;
    ensure_file(&paths.lock_file)?;

    Ok(())
}

pub fn remove_ready(paths: &Paths) -> Result<()> {
    match fs::remove_file(&paths.ready_file) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("remove {}", paths.ready_file.display())),
    }
}

fn ensure_file(path: &std::path::Path) -> Result<()> {
    if path.exists() {
        return Ok(());
    }
    fs::write(path, []).with_context(|| format!("create {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::ensure;
    use crate::paths::Paths;

    #[test]
    fn ensure_creates_public_and_internal_layout() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::new(
            temp.path().join("opt/persistd"),
            temp.path().join("run/persistd"),
            temp.path().join("data/persistd"),
        );

        ensure(&paths).unwrap();

        assert!(paths.config_file.is_file());
        assert!(paths.changed_dir.is_dir());
        assert!(paths.removed_dir.is_dir());
        assert!(paths.metadata_file.is_file());
        assert!(paths.internal_dir.is_dir());
        assert!(paths.lock_file.is_file());
        assert!(!paths.data_dir.join("db.sqlite").exists());
        assert!(!paths.data_dir.join("objects").exists());
    }
}
