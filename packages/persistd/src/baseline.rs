#![allow(dead_code)]

#[cfg(unix)]
mod imp {
    use anyhow::{Context, Result, bail};
    use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
    use std::{
        fs::{self, File},
        path::{Path, PathBuf},
    };
    use walkdir::{DirEntry, WalkDir};

    use crate::{
        public::PublicPath,
        rootfs::{self, FileKind},
    };

    pub const BASELINE_SCHEMA_VERSION: i64 = 2;

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

        fsync_file(&temp_output)?;
        fs::rename(&temp_output, &options.output).with_context(|| {
            format!(
                "publish baseline {} to {}",
                temp_output.display(),
                options.output.display()
            )
        })?;
        rootfs::fsync_parent(&options.output)?;

        Ok(())
    }

    fn migrate(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "
        PRAGMA journal_mode = DELETE;
        PRAGMA foreign_keys = ON;

        CREATE TABLE meta (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
        );

        INSERT INTO meta (key, value) VALUES ('schema_version', '2');

        CREATE TABLE records (
            path_bytes BLOB PRIMARY KEY NOT NULL,
            path TEXT NOT NULL,
            kind TEXT NOT NULL,
            mode INTEGER NOT NULL,
            uid INTEGER NOT NULL,
            gid INTEGER NOT NULL,
            size INTEGER,
            mtime_ns INTEGER NOT NULL,
            content_hash TEXT,
            symlink_target_bytes BLOB,
            symlink_target TEXT,
            rdev_major INTEGER,
            rdev_minor INTEGER,
            dev INTEGER NOT NULL,
            ino INTEGER NOT NULL,
            nlink INTEGER NOT NULL,
            hardlink_key TEXT,
            xattr_json TEXT,
            acl_json TEXT,
            capability_json TEXT
        );

        CREATE INDEX records_path_display ON records(path);
        CREATE INDEX records_kind ON records(kind);
        CREATE INDEX records_hardlink_key ON records(hardlink_key);
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
                path_bytes,
                path,
                kind,
                mode,
                uid,
                gid,
                size,
                mtime_ns,
                content_hash,
                symlink_target_bytes,
                symlink_target,
                rdev_major,
                rdev_minor,
                dev,
                ino,
                nlink,
                hardlink_key,
                xattr_json,
                acl_json,
                capability_json
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
            ",
            )?;

            let mut entries = WalkDir::new(&options.root)
                .follow_links(false)
                .contents_first(false)
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
                    record.path.as_bytes(),
                    record.path.display(),
                    record.kind,
                    record.mode,
                    record.uid,
                    record.gid,
                    record.size,
                    record.mtime_ns,
                    record.content_hash,
                    record.symlink_target_bytes,
                    record.symlink_target,
                    record.rdev_major,
                    record.rdev_minor,
                    record.dev,
                    record.ino,
                    record.nlink,
                    record.hardlink_key,
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
        if path == options.output || path == options.output.with_extension("sqlite.tmp") {
            return Ok(true);
        }

        let public_path = public_path(&options.root, path)?;
        Ok(matches!(
            public_path.display().as_str(),
            "/proc" | "/sys" | "/dev" | "/run" | "/data" | "/opt/persistd/baseline.sqlite"
        ))
    }

    pub struct BaselineDb {
        conn: Connection,
    }

    impl BaselineDb {
        pub fn open(path: &Path) -> Result<Self> {
            let conn = Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .with_context(|| format!("open baseline {}", path.display()))?;
            let db = Self { conn };
            db.validate()?;
            Ok(db)
        }

        fn validate(&self) -> Result<()> {
            let schema_version: String = self
                .conn
                .query_row(
                    "SELECT value FROM meta WHERE key = 'schema_version'",
                    [],
                    |row| row.get(0),
                )
                .context("baseline schema version is missing")?;
            if schema_version.parse::<i64>()? != BASELINE_SCHEMA_VERSION {
                bail!("unsupported baseline schema version {schema_version}");
            }

            let integrity: String = self
                .conn
                .query_row("PRAGMA integrity_check", [], |row| row.get(0))
                .context("baseline integrity check failed")?;
            if integrity != "ok" {
                bail!("baseline integrity check failed: {integrity}");
            }
            Ok(())
        }

        pub fn get(&self, path: &PublicPath) -> Result<Option<BaselineRecord>> {
            self.conn
                .query_row(
                    "
                    SELECT
                        path_bytes,
                        kind,
                        mode,
                        uid,
                        gid,
                        size,
                        mtime_ns,
                        content_hash,
                        symlink_target_bytes,
                        symlink_target,
                        rdev_major,
                        rdev_minor,
                        dev,
                        ino,
                        nlink,
                        hardlink_key,
                        xattr_json,
                        acl_json,
                        capability_json
                    FROM records
                    WHERE path_bytes = ?1
                    ",
                    params![path.as_bytes()],
                    row_to_record,
                )
                .optional()
                .context("lookup baseline record")
        }

        pub fn all_paths(&self) -> Result<Vec<PublicPath>> {
            let mut statement = self
                .conn
                .prepare("SELECT path_bytes FROM records ORDER BY path_bytes")
                .context("prepare baseline path scan")?;
            let rows = statement
                .query_map([], |row| row.get::<_, Vec<u8>>(0))
                .context("scan baseline paths")?;
            let mut paths = Vec::new();
            for row in rows {
                paths.push(PublicPath::from_absolute_bytes(&row?)?);
            }
            Ok(paths)
        }

        pub fn all_records(&self) -> Result<Vec<BaselineRecord>> {
            let mut statement = self
                .conn
                .prepare(
                    "
                    SELECT
                        path_bytes,
                        kind,
                        mode,
                        uid,
                        gid,
                        size,
                        mtime_ns,
                        content_hash,
                        symlink_target_bytes,
                        symlink_target,
                        rdev_major,
                        rdev_minor,
                        dev,
                        ino,
                        nlink,
                        hardlink_key,
                        xattr_json,
                        acl_json,
                        capability_json
                    FROM records
                    ORDER BY path_bytes
                    ",
                )
                .context("prepare baseline record scan")?;
            let rows = statement
                .query_map([], row_to_record)
                .context("scan baseline records")?;
            let mut records = Vec::new();
            for row in rows {
                records.push(row?);
            }
            Ok(records)
        }

        pub fn hardlink_group_paths(&self, hardlink_key: &str) -> Result<Vec<PublicPath>> {
            let mut statement = self
                .conn
                .prepare(
                    "SELECT path_bytes FROM records WHERE hardlink_key = ?1 ORDER BY path_bytes",
                )
                .context("prepare baseline hardlink group scan")?;
            let rows = statement
                .query_map(params![hardlink_key], |row| row.get::<_, Vec<u8>>(0))
                .context("scan baseline hardlink group")?;
            let mut paths = Vec::new();
            for row in rows {
                paths.push(PublicPath::from_absolute_bytes(&row?)?);
            }
            Ok(paths)
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct BaselineRecord {
        pub path: PublicPath,
        pub kind: String,
        pub mode: i64,
        pub uid: i64,
        pub gid: i64,
        pub size: Option<i64>,
        pub mtime_ns: i64,
        pub content_hash: Option<String>,
        pub symlink_target_bytes: Option<Vec<u8>>,
        pub symlink_target: Option<String>,
        pub rdev_major: Option<i64>,
        pub rdev_minor: Option<i64>,
        pub dev: i64,
        pub ino: i64,
        pub nlink: i64,
        pub hardlink_key: Option<String>,
        pub xattr_json: Option<String>,
        pub acl_json: Option<String>,
        pub capability_json: Option<String>,
    }

    impl BaselineRecord {
        fn from_entry(entry: &DirEntry, options: &GenerateOptions) -> Result<Self> {
            let path = entry.path();
            let public_path = public_path(&options.root, path)?;
            let facts = rootfs::facts(path)?;
            let content_hash = if matches!(facts.kind, FileKind::File) {
                Some(rootfs::hash_file(path)?)
            } else {
                None
            };
            let xattr_json = if facts.xattrs.is_empty() {
                None
            } else {
                Some(serde_json::to_string(&facts.xattrs)?)
            };
            let acl_json = acl_json(&facts.xattrs)?;
            let capability_json = capability_json(&facts.xattrs)?;
            let hardlink_key = if facts.nlink > 1 && matches!(facts.kind, FileKind::File) {
                Some(format!("{}:{}", facts.dev, facts.ino))
            } else {
                None
            };

            Ok(Self {
                path: public_path,
                kind: facts.kind.as_str().to_string(),
                mode: facts.mode.into(),
                uid: facts.uid.into(),
                gid: facts.gid.into(),
                size: facts.size.map(|size| size as i64),
                mtime_ns: facts.mtime_ns,
                content_hash,
                symlink_target: facts
                    .symlink_target
                    .as_ref()
                    .map(|target| display_bytes(target)),
                symlink_target_bytes: facts.symlink_target,
                rdev_major: facts.rdev_major.map(|value| value as i64),
                rdev_minor: facts.rdev_minor.map(|value| value as i64),
                dev: facts.dev as i64,
                ino: facts.ino as i64,
                nlink: facts.nlink as i64,
                hardlink_key,
                xattr_json,
                acl_json,
                capability_json,
            })
        }
    }

    fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<BaselineRecord> {
        let path_bytes: Vec<u8> = row.get(0)?;
        let path = PublicPath::from_absolute_bytes(&path_bytes).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                path_bytes.len(),
                rusqlite::types::Type::Blob,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    error.to_string(),
                )),
            )
        })?;
        Ok(BaselineRecord {
            path,
            kind: row.get(1)?,
            mode: row.get(2)?,
            uid: row.get(3)?,
            gid: row.get(4)?,
            size: row.get(5)?,
            mtime_ns: row.get(6)?,
            content_hash: row.get(7)?,
            symlink_target_bytes: row.get(8)?,
            symlink_target: row.get(9)?,
            rdev_major: row.get(10)?,
            rdev_minor: row.get(11)?,
            dev: row.get(12)?,
            ino: row.get(13)?,
            nlink: row.get(14)?,
            hardlink_key: row.get(15)?,
            xattr_json: row.get(16)?,
            acl_json: row.get(17)?,
            capability_json: row.get(18)?,
        })
    }

    fn public_path(root: &Path, path: &Path) -> Result<PublicPath> {
        let relative = path
            .strip_prefix(root)
            .with_context(|| format!("strip root {} from {}", root.display(), path.display()))?;
        PublicPath::from_root_relative(relative)
    }

    fn fsync_file(path: &Path) -> Result<()> {
        let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
        file.sync_all()
            .with_context(|| format!("fsync {}", path.display()))
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

    fn acl_json(xattrs: &[rootfs::XattrRecord]) -> Result<Option<String>> {
        let acl_records = xattrs
            .iter()
            .filter(|record| {
                matches!(
                    record.name.as_str(),
                    "system.posix_acl_access" | "system.posix_acl_default"
                )
            })
            .cloned()
            .collect::<Vec<_>>();
        if acl_records.is_empty() {
            Ok(None)
        } else {
            Ok(Some(serde_json::to_string(&acl_records)?))
        }
    }

    fn capability_json(xattrs: &[rootfs::XattrRecord]) -> Result<Option<String>> {
        xattrs
            .iter()
            .find(|record| record.name == "security.capability")
            .map(serde_json::to_string)
            .transpose()
            .context("encode file capability xattr")
    }

    #[cfg(test)]
    mod tests {
        use super::{BaselineDb, GenerateOptions, generate};
        use rusqlite::{Connection, OptionalExtension, params};
        use std::{
            ffi::OsString,
            fs,
            os::unix::{ffi::OsStringExt, fs::symlink},
        };

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

            let target: Vec<u8> = conn
                .query_row(
                    "SELECT symlink_target_bytes FROM records WHERE path = '/etc/hello-link'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(target, b"/etc/hello.txt");
        }

        #[test]
        fn baseline_generation_excludes_itself_and_runtime_roots() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("root");
            let output = root.join("opt/persistd/baseline.sqlite");
            fs::create_dir_all(root.join("opt/persistd/bin")).unwrap();
            fs::create_dir_all(root.join("data")).unwrap();
            fs::create_dir_all(root.join("run")).unwrap();
            fs::write(&output, "old baseline").unwrap();
            fs::write(root.join("data/user-file"), "ignored").unwrap();
            fs::write(root.join("run/runtime-file"), "ignored").unwrap();
            fs::write(root.join("opt/persistd/bin/persistd"), "kept").unwrap();

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

            let persistd: Option<String> = conn
                .query_row(
                    "SELECT path FROM records WHERE path = '/opt/persistd/bin/persistd'",
                    [],
                    |row| row.get(0),
                )
                .optional()
                .unwrap();
            assert_eq!(persistd, Some("/opt/persistd/bin/persistd".into()));
        }

        #[test]
        fn baseline_records_full_mtime_and_non_utf8_identity() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("root");
            let output = root.join("opt/persistd/baseline.sqlite");
            let name = OsString::from_vec(vec![b'b', b'a', b'd', 0xff]);
            fs::create_dir_all(root.join("opt/persistd")).unwrap();
            fs::write(root.join(&name), "hello").unwrap();
            filetime::set_file_mtime(
                root.join(&name),
                filetime::FileTime::from_unix_time(123, 456),
            )
            .unwrap();

            generate(&GenerateOptions {
                root,
                output: output.clone(),
            })
            .unwrap();

            let db = BaselineDb::open(&output).unwrap();
            let public_path = crate::public::PublicPath::from_absolute_bytes(b"/bad\xff").unwrap();
            let record = db.get(&public_path).unwrap().unwrap();
            assert_eq!(record.path.as_bytes(), b"/bad\xff");
            assert_eq!(record.mtime_ns, 123_000_000_456);
        }

        #[test]
        fn baseline_open_fails_for_missing_or_corrupt_database() {
            let temp = tempfile::tempdir().unwrap();
            let missing = temp.path().join("missing.sqlite");
            assert!(BaselineDb::open(&missing).is_err());

            fs::write(&missing, "not sqlite").unwrap();
            assert!(BaselineDb::open(&missing).is_err());
        }

        #[test]
        fn baseline_records_fifo_hardlink_and_xattr_facts() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("root");
            let output = root.join("opt/persistd/baseline.sqlite");
            fs::create_dir_all(root.join("opt/persistd")).unwrap();
            fs::write(root.join("a"), "same").unwrap();
            fs::hard_link(root.join("a"), root.join("b")).unwrap();
            xattr::set(root.join("a"), "user.persistd-test", b"value").unwrap();
            unsafe {
                let fifo = root.join("fifo");
                let c = std::ffi::CString::new(std::os::unix::ffi::OsStrExt::as_bytes(
                    fifo.as_os_str(),
                ))
                .unwrap();
                assert_eq!(libc::mkfifo(c.as_ptr(), 0o644), 0);
            }

            generate(&GenerateOptions {
                root,
                output: output.clone(),
            })
            .unwrap();

            let db = BaselineDb::open(&output).unwrap();
            let a = db
                .get(&crate::public::PublicPath::parse("/a").unwrap())
                .unwrap()
                .unwrap();
            let b = db
                .get(&crate::public::PublicPath::parse("/b").unwrap())
                .unwrap()
                .unwrap();
            let fifo = db
                .get(&crate::public::PublicPath::parse("/fifo").unwrap())
                .unwrap()
                .unwrap();

            assert_eq!(a.hardlink_key, b.hardlink_key);
            assert!(a.xattr_json.unwrap().contains("user.persistd-test"));
            assert_eq!(fifo.kind, "fifo");
        }

        #[test]
        fn baseline_extracts_acl_and_capability_views_from_xattrs() {
            let xattrs = vec![
                crate::rootfs::XattrRecord {
                    name: "system.posix_acl_access".into(),
                    name_bytes_b64: {
                        use base64::Engine as _;
                        base64::engine::general_purpose::STANDARD.encode("system.posix_acl_access")
                    },
                    value_b64: {
                        use base64::Engine as _;
                        base64::engine::general_purpose::STANDARD.encode("acl")
                    },
                },
                crate::rootfs::XattrRecord {
                    name: "security.capability".into(),
                    name_bytes_b64: {
                        use base64::Engine as _;
                        base64::engine::general_purpose::STANDARD.encode("security.capability")
                    },
                    value_b64: {
                        use base64::Engine as _;
                        base64::engine::general_purpose::STANDARD.encode("cap")
                    },
                },
            ];

            assert!(
                super::acl_json(&xattrs)
                    .unwrap()
                    .unwrap()
                    .contains("posix_acl")
            );
            assert!(
                super::capability_json(&xattrs)
                    .unwrap()
                    .unwrap()
                    .contains("security.capability")
            );
        }
    }
}

#[cfg(unix)]
#[allow(unused_imports)]
pub use imp::{BASELINE_SCHEMA_VERSION, BaselineDb, BaselineRecord, GenerateOptions, generate};
