#![allow(dead_code)]

#[cfg(unix)]
mod imp {
    use anyhow::{Context, Result};
    use rusqlite::{Connection, params};
    use std::{
        fs::{self, File, Metadata},
        io::BufReader,
        os::unix::fs::{FileTypeExt, MetadataExt},
        path::{Path, PathBuf},
    };
    use walkdir::{DirEntry, WalkDir};

    #[derive(Debug, Clone)]
    pub struct GenerateOptions {
        pub root: PathBuf,
        pub output: PathBuf,
    }

    pub fn generate(options: &GenerateOptions) -> Result<()> {
        let output_parent = options.output.parent().with_context(|| {
            format!(
                "baseline output has no parent: {}",
                options.output.display()
            )
        })?;
        fs::create_dir_all(output_parent)
            .with_context(|| format!("create baseline dir {}", output_parent.display()))?;

        let temp_output = options.output.with_extension("sqlite.tmp");
        let _ = fs::remove_file(&temp_output);

        let mut conn = Connection::open(&temp_output)
            .with_context(|| format!("open baseline {}", temp_output.display()))?;
        migrate(&conn)?;
        insert_records(&mut conn, options)?;

        fs::rename(&temp_output, &options.output).with_context(|| {
            format!(
                "publish baseline {} to {}",
                temp_output.display(),
                options.output.display()
            )
        })?;

        Ok(())
    }

    fn migrate(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "
        PRAGMA journal_mode = DELETE;
        PRAGMA foreign_keys = ON;

        CREATE TABLE records (
            path TEXT PRIMARY KEY NOT NULL,
            kind TEXT NOT NULL,
            mode INTEGER NOT NULL,
            uid INTEGER NOT NULL,
            gid INTEGER NOT NULL,
            size INTEGER,
            mtime_ns INTEGER NOT NULL,
            content_hash TEXT,
            symlink_target TEXT,
            rdev_major INTEGER,
            rdev_minor INTEGER,
            xattr_json TEXT,
            acl_json TEXT,
            capability_json TEXT
        );

        CREATE INDEX records_kind ON records(kind);
        ",
        )
        .context("migrate baseline database")
    }

    fn insert_records(conn: &mut Connection, options: &GenerateOptions) -> Result<()> {
        let tx = conn.transaction().context("begin baseline transaction")?;
        {
            let mut insert = tx.prepare(
                "
            INSERT INTO records (
                path,
                kind,
                mode,
                uid,
                gid,
                size,
                mtime_ns,
                content_hash,
                symlink_target,
                rdev_major,
                rdev_minor,
                xattr_json,
                acl_json,
                capability_json
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            ",
            )?;

            let mut entries = WalkDir::new(&options.root)
                .follow_links(false)
                .contents_first(false)
                .same_file_system(true)
                .into_iter();

            while let Some(entry) = entries.next() {
                let entry = entry?;
                if entry.path() == options.root {
                    continue;
                }
                if should_skip(&entry, options)? {
                    if entry.file_type().is_dir() {
                        entries.skip_current_dir();
                    }
                    continue;
                }

                let record = BaselineRecord::from_entry(&entry, options)?;
                insert.execute(params![
                    record.path,
                    record.kind,
                    record.mode,
                    record.uid,
                    record.gid,
                    record.size,
                    record.mtime_ns,
                    record.content_hash,
                    record.symlink_target,
                    record.rdev_major,
                    record.rdev_minor,
                    record.xattr_json,
                    record.acl_json,
                    record.capability_json,
                ])?;
            }
        }
        tx.commit().context("commit baseline transaction")
    }

    fn should_skip(entry: &DirEntry, options: &GenerateOptions) -> Result<bool> {
        let path = entry.path();
        if path == options.output {
            return Ok(true);
        }
        if path == options.output.with_extension("sqlite.tmp") {
            return Ok(true);
        }

        let display = display_path(&options.root, path)?;
        Ok(matches!(
            display.as_str(),
            "/proc" | "/sys" | "/dev" | "/run" | "/data" | "/opt/persistd/baseline.sqlite"
        ))
    }

    #[derive(Debug)]
    struct BaselineRecord {
        path: String,
        kind: &'static str,
        mode: i64,
        uid: i64,
        gid: i64,
        size: Option<i64>,
        mtime_ns: i64,
        content_hash: Option<String>,
        symlink_target: Option<String>,
        rdev_major: Option<i64>,
        rdev_minor: Option<i64>,
        xattr_json: Option<String>,
        acl_json: Option<String>,
        capability_json: Option<String>,
    }

    impl BaselineRecord {
        fn from_entry(entry: &DirEntry, options: &GenerateOptions) -> Result<Self> {
            let path = entry.path();
            let metadata = fs::symlink_metadata(path)
                .with_context(|| format!("stat baseline path {}", path.display()))?;
            let file_type = metadata.file_type();
            let kind = kind(&file_type);
            let size = if file_type.is_file() {
                Some(metadata.len().try_into().context("file size overflow")?)
            } else {
                None
            };
            let content_hash = if file_type.is_file() {
                Some(hash_file(path)?)
            } else {
                None
            };
            let symlink_target = if file_type.is_symlink() {
                Some(fs::read_link(path)?.to_string_lossy().into_owned())
            } else {
                None
            };
            let (rdev_major, rdev_minor) = device_numbers(&metadata, &file_type);

            Ok(Self {
                path: display_path(&options.root, path)?,
                kind,
                mode: metadata.mode().into(),
                uid: metadata.uid().into(),
                gid: metadata.gid().into(),
                size,
                mtime_ns: metadata.mtime_nsec(),
                content_hash,
                symlink_target,
                rdev_major,
                rdev_minor,
                xattr_json: None,
                acl_json: None,
                capability_json: None,
            })
        }
    }

    fn kind(file_type: &std::fs::FileType) -> &'static str {
        if file_type.is_file() {
            "file"
        } else if file_type.is_dir() {
            "dir"
        } else if file_type.is_symlink() {
            "symlink"
        } else if file_type.is_fifo() {
            "fifo"
        } else if file_type.is_socket() {
            "socket"
        } else if file_type.is_char_device() {
            "char_device"
        } else if file_type.is_block_device() {
            "block_device"
        } else {
            "unknown"
        }
    }

    fn hash_file(path: &Path) -> Result<String> {
        let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
        let mut reader = BufReader::new(file);
        let mut hasher = blake3::Hasher::new();
        hasher
            .update_reader(&mut reader)
            .with_context(|| format!("hash {}", path.display()))?;
        Ok(hasher.finalize().to_hex().to_string())
    }

    fn device_numbers(
        metadata: &Metadata,
        file_type: &std::fs::FileType,
    ) -> (Option<i64>, Option<i64>) {
        if !(file_type.is_char_device() || file_type.is_block_device()) {
            return (None, None);
        }

        let rdev = metadata.rdev();
        let major = ((rdev >> 8) & 0xfff) | ((rdev >> 32) & !0xfff);
        let minor = (rdev & 0xff) | ((rdev >> 12) & !0xff);
        (Some(major as i64), Some(minor as i64))
    }

    fn display_path(root: &Path, path: &Path) -> Result<String> {
        let relative = path
            .strip_prefix(root)
            .with_context(|| format!("strip root {} from {}", root.display(), path.display()))?;
        let text = relative.to_string_lossy().replace('\\', "/");
        Ok(format!("/{text}"))
    }

    #[cfg(test)]
    mod tests {
        use super::{GenerateOptions, generate};
        use rusqlite::{Connection, OptionalExtension, params};
        use std::{fs, os::unix::fs::symlink};

        #[test]
        fn baseline_generation_records_file_hash_and_symlink_target() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("root");
            let output = root.join("opt/persistd/baseline.sqlite");
            fs::create_dir_all(root.join("opt/persistd")).unwrap();
            fs::create_dir_all(root.join("etc")).unwrap();
            fs::write(root.join("etc/hello.txt"), "hello").unwrap();
            symlink("/etc/hello.txt", root.join("etc/hello-link")).unwrap();

            generate(&GenerateOptions {
                root: root.clone(),
                output: output.clone(),
            })
            .unwrap();

            let conn = Connection::open(output).unwrap();
            let hash: String = conn
                .query_row(
                    "SELECT content_hash FROM records WHERE path = '/etc/hello.txt'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(hash, blake3::hash(b"hello").to_hex().to_string());

            let target: String = conn
                .query_row(
                    "SELECT symlink_target FROM records WHERE path = '/etc/hello-link'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(target, "/etc/hello.txt");
        }

        #[test]
        fn baseline_generation_excludes_itself_and_runtime_roots() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("root");
            let output = root.join("opt/persistd/baseline.sqlite");
            fs::create_dir_all(root.join("opt/persistd")).unwrap();
            fs::create_dir_all(root.join("data")).unwrap();
            fs::create_dir_all(root.join("run")).unwrap();
            fs::write(&output, "old baseline").unwrap();
            fs::write(root.join("data/user-file"), "ignored").unwrap();
            fs::write(root.join("run/runtime-file"), "ignored").unwrap();

            generate(&GenerateOptions {
                root: root.clone(),
                output: output.clone(),
            })
            .unwrap();

            let conn = Connection::open(output).unwrap();
            for path in [
                "/opt/persistd/baseline.sqlite",
                "/data",
                "/data/user-file",
                "/run",
                "/run/runtime-file",
            ] {
                let found: Option<String> = conn
                    .query_row(
                        "SELECT path FROM records WHERE path = ?1",
                        params![path],
                        |row| row.get(0),
                    )
                    .optional()
                    .unwrap();
                assert_eq!(found, None, "{path} should be excluded");
            }
        }

        #[test]
        fn baseline_schema_has_future_fidelity_columns() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("root");
            let output = root.join("opt/persistd/baseline.sqlite");
            fs::create_dir_all(root.join("opt/persistd")).unwrap();

            generate(&GenerateOptions {
                root,
                output: output.clone(),
            })
            .unwrap();

            let conn = Connection::open(output).unwrap();
            for column in [
                "rdev_major",
                "rdev_minor",
                "xattr_json",
                "acl_json",
                "capability_json",
            ] {
                let count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM pragma_table_info('records') WHERE name = ?1",
                        params![column],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(count, 1, "missing column {column}");
            }
        }
    }
}
