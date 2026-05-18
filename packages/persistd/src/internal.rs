use anyhow::{Context, Result, bail};
use fs2::FileExt;
use rusqlite::{Connection, params};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::paths::Paths;

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
        let mut changed = list_public_paths(&paths.changed_dir)?;
        let mut removed = list_public_paths(&paths.removed_dir)?;
        changed.sort();
        removed.sort();

        let metadata_count = count_metadata_records(&paths.metadata_file)?;
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM public_index", [])?;

        for path in changed {
            tx.execute(
                "INSERT OR REPLACE INTO public_index (kind, path) VALUES ('changed', ?1)",
                params![path],
            )?;
        }
        for path in removed {
            tx.execute(
                "INSERT OR REPLACE INTO public_index (kind, path) VALUES ('removed', ?1)",
                params![path],
            )?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('metadata_record_count', ?1)",
            params![metadata_count.to_string()],
        )?;
        tx.commit()?;
        Ok(())
    }

    #[cfg(test)]
    fn public_count(&self, kind: &str) -> Result<u64> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM public_index WHERE kind = ?1",
            params![kind],
            |row| row.get(0),
        )?;
        count.try_into().context("public_count was negative")
    }

    #[cfg(test)]
    fn metadata_record_count(&self) -> Result<u64> {
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

    pub fn record_phase_success(&self, phase: &str) -> Result<()> {
        let now = timestamp();
        self.conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
            params![format!("last_{phase}_success_at"), now],
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

fn list_public_paths(root: &Path) -> Result<Vec<String>> {
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut paths = Vec::new();
    collect_public_paths(root, root, &mut paths)?;
    Ok(paths)
}

fn collect_public_paths(root: &Path, current: &Path, paths: &mut Vec<String>) -> Result<()> {
    for entry in fs::read_dir(current).with_context(|| format!("read {}", current.display()))? {
        let entry = entry?;
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .with_context(|| format!("strip public root {}", root.display()))?;
        paths.push(format_public_path(relative));

        if entry.file_type()?.is_dir() {
            collect_public_paths(root, &path, paths)?;
        }
    }
    Ok(())
}

fn format_public_path(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    format!("/{text}")
}

fn count_metadata_records(path: &Path) -> Result<u64> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error).with_context(|| format!("open {}", path.display())),
    };

    let mut count = 0;
    for line in BufReader::new(file).lines() {
        if !line?.trim().is_empty() {
            count += 1;
        }
    }
    Ok(count)
}

fn timestamp() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}-{:09}", duration.as_secs(), duration.subsec_nanos())
}

pub fn assert_daemon_not_running(paths: &Paths) -> Result<()> {
    if paths.control_socket.exists() {
        bail!(
            "daemon control socket already exists at {}",
            paths.control_socket.display()
        );
    }
    Ok(())
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
        fs::write(paths.removed_dir.join("deleted"), "").unwrap();
        fs::write(&paths.metadata_file, "{\"path\":\"/etc/hosts\"}\n\n").unwrap();

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

    fn test_paths(root: &std::path::Path) -> Paths {
        Paths::new(
            root.join("opt/persistd"),
            root.join("run/persistd"),
            root.join("data/persistd"),
        )
    }
}
