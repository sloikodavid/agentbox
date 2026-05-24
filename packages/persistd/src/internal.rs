use anyhow::{Context, Result};
use fs2::FileExt;
use rusqlite::{Connection, params};
use std::{
    fs::{self, File, OpenOptions},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{metadata, paths::Paths, public};

pub struct WriterLock {
    _file: File,
}

impl WriterLock {
    pub fn acquire(paths: &Paths) -> Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&paths.lock_file)
            .with_context(|| format!("open lock {}", paths.lock_file.display()))?;

        file.try_lock_exclusive()
            .with_context(|| format!("acquire lock {}", paths.lock_file.display()))?;

        Ok(Self { _file: file })
    }
}

pub struct StateDb {
    conn: Connection,
}

impl StateDb {
    pub fn open_or_rebuild(paths: &Paths) -> Result<Self> {
        match Self::open(paths) {
            Ok(db) => Ok(db),
            Err(error) => {
                tracing::warn!(error = %error, "rebuilding corrupt internal state database");
                move_corrupt_db(paths)?;
                Self::open(paths)
            }
        }
    }

    fn open(paths: &Paths) -> Result<Self> {
        let conn = Connection::open(&paths.state_db)
            .with_context(|| format!("open {}", paths.state_db.display()))?;
        let db = Self { conn };
        db.migrate()?;
        db.rebuild_public_index(paths)?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        self.conn
            .execute_batch(
                "
                PRAGMA journal_mode = WAL;
                PRAGMA foreign_keys = ON;

                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS public_index (
                    kind TEXT NOT NULL,
                    path TEXT NOT NULL,
                    PRIMARY KEY (kind, path)
                );
                ",
            )
            .context("migrate internal state database")?;
        Ok(())
    }

    pub fn rebuild_public_index(&self, paths: &Paths) -> Result<()> {
        let mut changed = public::list_public_paths(&paths.changed_dir)?;
        let mut removed = public::list_public_file_paths(&paths.removed_dir)?;
        changed.sort();
        removed.sort();

        let metadata_count = metadata::load(&paths.metadata_file)?.len();
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM public_index", [])?;

        for path in changed {
            tx.execute(
                "INSERT OR REPLACE INTO public_index (kind, path) VALUES ('changed', ?1)",
                params![path.display()],
            )?;
        }
        for path in removed {
            tx.execute(
                "INSERT OR REPLACE INTO public_index (kind, path) VALUES ('removed', ?1)",
                params![path.display()],
            )?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('metadata_record_count', ?1)",
            params![metadata_count.to_string()],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn public_count(&self, kind: &str) -> Result<u64> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM public_index WHERE kind = ?1",
            params![kind],
            |row| row.get(0),
        )?;
        count.try_into().context("public_count was negative")
    }

    pub fn metadata_record_count(&self) -> Result<u64> {
        let value = match self.conn.query_row(
            "SELECT value FROM meta WHERE key = 'metadata_record_count'",
            [],
            |row| row.get::<_, String>(0),
        ) {
            Ok(value) => value,
            Err(rusqlite::Error::QueryReturnedNoRows) => "0".to_string(),
            Err(error) => return Err(error).context("read metadata_record_count"),
        };
        let count = value.parse().context("parse metadata_record_count")?;
        Ok(count)
    }

    pub fn meta_value(&self, key: &str) -> Result<Option<String>> {
        match self.conn.query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        ) {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error).with_context(|| format!("read meta key {key}")),
        }
    }

    pub fn record_phase_success(&self, phase: &str) -> Result<()> {
        let now = timestamp();
        self.set_meta(&format!("last_{phase}_success_at"), &now)?;
        self.set_meta("last_error", "")?;
        Ok(())
    }

    pub fn record_phase_failure(&self, phase: &str, error: &str) -> Result<()> {
        let now = timestamp();
        self.set_meta(&format!("last_{phase}_failure_at"), &now)?;
        self.set_meta("last_error", error)?;
        self.set_meta(&format!("last_{phase}_error"), error)?;
        Ok(())
    }

    pub fn record_diagnostic(&self, key: &str, value: &str) -> Result<()> {
        self.set_meta(&format!("diagnostic_{key}"), value)
    }

    fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }
}

fn move_corrupt_db(paths: &Paths) -> Result<()> {
    if !paths.state_db.exists() {
        return Ok(());
    }

    let backup = paths
        .state_db
        .with_file_name(format!("state.sqlite.corrupt.{}", timestamp()));
    fs::rename(&paths.state_db, &backup).with_context(|| {
        format!(
            "move corrupt state db {} to {}",
            paths.state_db.display(),
            backup.display()
        )
    })
}

fn timestamp() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}-{:09}", duration.as_secs(), duration.subsec_nanos())
}

pub fn write_error_log(path: &Path, error: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    fs::write(path, format!("{error}\n")).with_context(|| format!("write {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::{StateDb, WriterLock};
    use crate::{layout, paths::Paths};
    use std::fs;

    #[test]
    fn lock_prevents_a_second_writer() {
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        layout::ensure(&paths).unwrap();

        let _first = WriterLock::acquire(&paths).unwrap();
        assert!(WriterLock::acquire(&paths).is_err());
    }

    #[test]
    fn db_rebuilds_public_index_from_public_truth() {
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        layout::ensure(&paths).unwrap();
        fs::create_dir_all(paths.changed_dir.join("etc")).unwrap();
        fs::write(paths.changed_dir.join("etc/hosts"), "changed").unwrap();
        fs::create_dir_all(paths.removed_dir.join("nested")).unwrap();
        fs::write(paths.removed_dir.join("nested/deleted"), "").unwrap();
        fs::write(
            &paths.metadata_file,
            "{\"path\":\"/etc/hosts\",\"kind\":\"file\"}\n\n",
        )
        .unwrap();

        let db = StateDb::open_or_rebuild(&paths).unwrap();

        assert_eq!(db.public_count("changed").unwrap(), 2);
        assert_eq!(db.public_count("removed").unwrap(), 1);
        assert_eq!(db.metadata_record_count().unwrap(), 1);
    }

    #[test]
    fn corrupt_db_is_moved_aside_and_rebuilt() {
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        layout::ensure(&paths).unwrap();
        fs::write(&paths.state_db, "not sqlite").unwrap();

        let db = StateDb::open_or_rebuild(&paths).unwrap();

        assert_eq!(db.public_count("changed").unwrap(), 0);
        assert!(paths.internal_dir.read_dir().unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("state.sqlite.corrupt.")
        }));
    }

    #[test]
    fn records_phase_failures_and_error_logs() {
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        layout::ensure(&paths).unwrap();
        let db = StateDb::open_or_rebuild(&paths).unwrap();

        db.record_phase_failure("apply", "missing baseline")
            .unwrap();
        super::write_error_log(&paths.apply_error_log, "missing baseline").unwrap();

        assert_eq!(
            db.meta_value("last_error").unwrap().as_deref(),
            Some("missing baseline")
        );
        assert!(
            fs::read_to_string(paths.apply_error_log)
                .unwrap()
                .contains("missing baseline")
        );
    }

    fn test_paths(root: &std::path::Path) -> Paths {
        Paths::new(
            root.join("opt/persistd"),
            root.join("run/persistd"),
            root.join("data/persistd"),
        )
    }
}
