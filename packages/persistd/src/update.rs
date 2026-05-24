#![cfg(unix)]
#![allow(dead_code)]

use anyhow::{Context, Result, bail};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

use crate::{
    baseline::{BaselineDb, BaselineRecord},
    config::Config,
    metadata::{self, MetadataRecord},
    paths::Paths,
    public::{self, PublicPath},
    rootfs::{self, FileKind, FsFacts},
};

pub struct UpdateContext<'a> {
    pub root: &'a Path,
    pub paths: &'a Paths,
    pub config: &'a Config,
    pub baseline: &'a BaselineDb,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateOutcome {
    Ignored,
    Pruned,
    PersistedChanged,
    PersistedMetadata,
    PersistedRemoved,
}

pub fn update_path(ctx: &UpdateContext<'_>, path: &str) -> Result<UpdateOutcome> {
    update_public_path(ctx, &PublicPath::parse(path)?)
}

pub fn update_public_path(
    ctx: &UpdateContext<'_>,
    public_path: &PublicPath,
) -> Result<UpdateOutcome> {
    if public::is_excluded(public_path, ctx.config) {
        return Ok(UpdateOutcome::Ignored);
    }

    let live_path = public::live_path(ctx.root, public_path);
    let baseline = ctx.baseline.get(public_path)?;
    let live = match rootfs::facts(&live_path) {
        Ok(facts) => Some(facts),
        Err(error) => {
            let not_found = error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
                || (!live_path.exists() && fs::symlink_metadata(&live_path).is_err());
            if not_found {
                None
            } else {
                return Err(error).with_context(|| format!("inspect {}", live_path.display()));
            }
        }
    };

    match (live, baseline) {
        (None, Some(_)) => {
            remove_changed(ctx.paths, public_path)?;
            write_removed_marker(ctx.paths, public_path)?;
            metadata::remove(&ctx.paths.metadata_file, public_path)?;
            Ok(UpdateOutcome::PersistedRemoved)
        }
        (None, None) => {
            remove_changed(ctx.paths, public_path)?;
            remove_removed_marker(ctx.paths, public_path)?;
            metadata::remove(&ctx.paths.metadata_file, public_path)?;
            Ok(UpdateOutcome::Pruned)
        }
        (Some(live), Some(record)) => {
            let decision = compare_to_baseline(ctx, public_path, &live_path, &live, &record)?;
            match decision {
                DeltaDecision::Equal => {
                    remove_changed(ctx.paths, public_path)?;
                    remove_removed_marker(ctx.paths, public_path)?;
                    metadata::remove(&ctx.paths.metadata_file, public_path)?;
                    Ok(UpdateOutcome::Pruned)
                }
                DeltaDecision::MetadataOnly => {
                    remove_changed(ctx.paths, public_path)?;
                    remove_removed_marker(ctx.paths, public_path)?;
                    metadata::upsert(
                        &ctx.paths.metadata_file,
                        metadata_record(public_path, &live)?,
                    )?;
                    Ok(UpdateOutcome::PersistedMetadata)
                }
                DeltaDecision::Changed => {
                    persist_changed(ctx.paths, public_path, &live_path, &live)?;
                    remove_removed_marker(ctx.paths, public_path)?;
                    Ok(UpdateOutcome::PersistedChanged)
                }
            }
        }
        (Some(live), None) => {
            persist_changed(ctx.paths, public_path, &live_path, &live)?;
            remove_removed_marker(ctx.paths, public_path)?;
            Ok(UpdateOutcome::PersistedChanged)
        }
    }
}

enum DeltaDecision {
    Equal,
    MetadataOnly,
    Changed,
}

fn compare_to_baseline(
    ctx: &UpdateContext<'_>,
    public_path: &PublicPath,
    live_path: &Path,
    live: &FsFacts,
    record: &BaselineRecord,
) -> Result<DeltaDecision> {
    if live.kind.as_str() != record.kind {
        return Ok(DeltaDecision::Changed);
    }

    let content_changed = match live.kind {
        FileKind::File => {
            let size: i64 = live
                .size
                .unwrap_or(0)
                .try_into()
                .context("file size overflow")?;
            Some(size) != record.size || Some(rootfs::hash_file(live_path)?) != record.content_hash
        }
        FileKind::Symlink => {
            live.symlink_target.as_deref() != record.symlink_target_bytes.as_deref()
        }
        FileKind::CharDevice | FileKind::BlockDevice => {
            live.rdev_major.map(|value| value as i64) != record.rdev_major
                || live.rdev_minor.map(|value| value as i64) != record.rdev_minor
        }
        FileKind::Socket => false,
        FileKind::Dir | FileKind::Fifo | FileKind::Unknown => false,
    };

    if content_changed {
        return Ok(DeltaDecision::Changed);
    }

    if hardlink_topology_changed(ctx, public_path, live, record)? {
        return Ok(DeltaDecision::Changed);
    }

    if metadata_differs(live, record)? {
        return Ok(DeltaDecision::MetadataOnly);
    }

    Ok(DeltaDecision::Equal)
}

fn hardlink_topology_changed(
    ctx: &UpdateContext<'_>,
    public_path: &PublicPath,
    live: &FsFacts,
    record: &BaselineRecord,
) -> Result<bool> {
    if !matches!(live.kind, FileKind::File) {
        return Ok(false);
    }

    let baseline_group = match &record.hardlink_key {
        Some(key) => ctx
            .baseline
            .hardlink_group_paths(key)
            .with_context(|| format!("load baseline hardlink group for {}", public_path))?,
        None => return Ok(live.nlink > 1),
    };

    if live.nlink as i64 != record.nlink {
        return Ok(true);
    }

    for sibling in baseline_group {
        if public::is_excluded(&sibling, ctx.config) {
            continue;
        }
        let sibling_path = public::live_path(ctx.root, &sibling);
        let sibling_facts = match rootfs::facts(&sibling_path) {
            Ok(facts) => facts,
            Err(error) => {
                let missing = error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
                    || fs::symlink_metadata(&sibling_path).is_err();
                if missing {
                    return Ok(true);
                }
                return Err(error).with_context(|| format!("inspect hardlink sibling {}", sibling));
            }
        };
        if sibling_facts.dev != live.dev || sibling_facts.ino != live.ino {
            return Ok(true);
        }
    }

    Ok(false)
}

fn metadata_differs(live: &FsFacts, record: &BaselineRecord) -> Result<bool> {
    if i64::from(live.mode) != record.mode
        || i64::from(live.uid) != record.uid
        || i64::from(live.gid) != record.gid
        || !mtime_matches_baseline(live.mtime_ns, record.mtime_ns)
    {
        return Ok(true);
    }

    let baseline_xattrs = record
        .xattr_json
        .as_deref()
        .map(serde_json::from_str::<Vec<rootfs::XattrRecord>>)
        .transpose()?
        .unwrap_or_default();
    Ok(live.xattrs != baseline_xattrs)
}

pub(crate) fn mtime_matches_baseline(live_mtime_ns: i64, baseline_mtime_ns: i64) -> bool {
    live_mtime_ns == baseline_mtime_ns
        || live_mtime_ns == baseline_mtime_ns.div_euclid(1_000_000_000) * 1_000_000_000
}

fn persist_changed(
    paths: &Paths,
    public_path: &PublicPath,
    live_path: &Path,
    live: &FsFacts,
) -> Result<()> {
    let destination = public_path.destination(&paths.changed_dir);
    match live.kind {
        FileKind::Socket => {
            bail!("refusing to persist live socket {}", live_path.display());
        }
        FileKind::CharDevice | FileKind::BlockDevice => {
            match rootfs::copy_entry_atomic(live_path, &destination) {
                Ok(()) => {}
                Err(error) => {
                    metadata::upsert(
                        &paths.metadata_file,
                        metadata_record(public_path, live).with_context(|| {
                            format!("record fallback metadata for {}", public_path)
                        })?,
                    )?;
                    tracing::warn!(
                        error = %error,
                        path = %public_path,
                        "stored device node as fallback metadata"
                    );
                    return Ok(());
                }
            }
        }
        _ => match rootfs::copy_entry_atomic(live_path, &destination) {
            Ok(()) => {}
            Err(error) if rootfs::is_xattr_error(&error) => {
                rootfs::copy_entry_atomic_without_xattrs(live_path, &destination)?;
                metadata::upsert(
                    &paths.metadata_file,
                    metadata_record(public_path, live).with_context(|| {
                        format!("record xattr fallback metadata for {}", public_path)
                    })?,
                )?;
                tracing::warn!(
                    error = %error,
                    path = %public_path,
                    "stored xattrs as fallback metadata"
                );
                return Ok(());
            }
            Err(error) => return Err(error),
        },
    }

    if metadata_record_needed(live) {
        metadata::upsert(&paths.metadata_file, metadata_record(public_path, live)?)?;
    } else {
        metadata::remove(&paths.metadata_file, public_path)?;
    }
    Ok(())
}

fn metadata_record_needed(live: &FsFacts) -> bool {
    live.nlink > 1 && matches!(live.kind, FileKind::File)
}

fn hardlink_key(live: &FsFacts) -> Option<String> {
    if live.nlink > 1 && matches!(live.kind, FileKind::File) {
        Some(format!("{}:{}", live.dev, live.ino))
    } else {
        None
    }
}

fn metadata_record(public_path: &PublicPath, live: &FsFacts) -> Result<MetadataRecord> {
    let mut record = MetadataRecord {
        version: 1,
        path: String::new(),
        path_bytes_b64: None,
        kind: live.kind.as_str().to_string(),
        mode: Some(live.mode),
        uid: Some(live.uid),
        gid: Some(live.gid),
        mtime_ns: Some(live.mtime_ns),
        symlink_target: live
            .symlink_target
            .as_ref()
            .map(|target| String::from_utf8_lossy(target).into_owned()),
        symlink_target_bytes_b64: live.symlink_target.as_ref().map(|target| {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD.encode(target)
        }),
        rdev_major: live.rdev_major,
        rdev_minor: live.rdev_minor,
        hardlink_key: hardlink_key(live),
        xattrs: if live.xattrs.is_empty() {
            None
        } else {
            Some(live.xattrs.clone())
        },
        acl: None,
        capability: None,
    };
    record.set_public_path(public_path);
    Ok(record)
}

fn remove_changed(paths: &Paths, public_path: &PublicPath) -> Result<()> {
    public::remove_path(&public_path.destination(&paths.changed_dir))
}

fn write_removed_marker(paths: &Paths, public_path: &PublicPath) -> Result<()> {
    let marker = public_path.destination(&paths.removed_dir);
    public::ensure_parent(&marker)?;
    let temp = public::temp_path(&marker);
    let _ = fs::remove_file(&temp);
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .with_context(|| format!("create removed marker {}", temp.display()))?;
        file.write_all(&[])
            .with_context(|| format!("write removed marker {}", temp.display()))?;
        file.sync_all()
            .with_context(|| format!("fsync removed marker {}", temp.display()))?;
    }
    fs::rename(&temp, &marker)
        .with_context(|| format!("publish removed marker {}", marker.display()))?;
    rootfs::fsync_parent(&marker)
}

fn remove_removed_marker(paths: &Paths, public_path: &PublicPath) -> Result<()> {
    public::remove_path(&public_path.destination(&paths.removed_dir))
}

#[cfg(test)]
mod tests {
    use super::{UpdateContext, UpdateOutcome, update_path};
    use crate::{
        baseline::{BaselineDb, GenerateOptions, generate},
        config::Config,
        layout,
        paths::Paths,
    };
    use std::{
        ffi::OsString,
        fs,
        os::unix::{ffi::OsStringExt, fs::symlink},
    };

    #[test]
    fn changed_file_is_captured_and_removed_marker_is_cleared() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("etc/hello.txt"), "changed").unwrap();
        fs::create_dir_all(fixture.paths.removed_dir.join("etc")).unwrap();
        fs::write(fixture.paths.removed_dir.join("etc/hello.txt"), "").unwrap();

        let outcome = update_path(&fixture.ctx(), "/etc/hello.txt").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedChanged);
        assert_eq!(
            fs::read_to_string(fixture.paths.changed_dir.join("etc/hello.txt")).unwrap(),
            "changed"
        );
        assert!(!fixture.paths.removed_dir.join("etc/hello.txt").exists());
    }

    #[test]
    fn baseline_equal_file_prunes_changed_removed_and_metadata_entries() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.changed_dir.join("etc")).unwrap();
        fs::write(fixture.paths.changed_dir.join("etc/hello.txt"), "stale").unwrap();
        fs::create_dir_all(fixture.paths.removed_dir.join("etc")).unwrap();
        fs::write(fixture.paths.removed_dir.join("etc/hello.txt"), "").unwrap();
        fs::write(
            &fixture.paths.metadata_file,
            r#"{"path":"/etc/hello.txt","kind":"file"}"#,
        )
        .unwrap();

        let outcome = update_path(&fixture.ctx(), "/etc/hello.txt").unwrap();

        assert_eq!(outcome, UpdateOutcome::Pruned);
        assert!(!fixture.paths.changed_dir.join("etc/hello.txt").exists());
        assert!(!fixture.paths.removed_dir.join("etc/hello.txt").exists());
        assert!(
            crate::metadata::load(&fixture.paths.metadata_file)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn touched_but_equal_file_records_only_metadata() {
        let fixture = Fixture::new();
        let file = fixture.root.join("etc/hello.txt");
        filetime::set_file_mtime(&file, filetime::FileTime::from_unix_time(999, 0)).unwrap();

        let outcome = update_path(&fixture.ctx(), "/etc/hello.txt").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedMetadata);
        assert!(!fixture.paths.changed_dir.join("etc/hello.txt").exists());
        assert_eq!(
            crate::metadata::load(&fixture.paths.metadata_file)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn docker_truncated_baseline_mtime_is_not_metadata_drift() {
        let fixture = Fixture::new();
        let file = fixture.root.join("etc/hello.txt");
        filetime::set_file_mtime(&file, filetime::FileTime::from_unix_time(123, 456_789_123))
            .unwrap();
        generate(&crate::baseline::GenerateOptions {
            root: fixture.root.clone(),
            output: fixture.paths.baseline_db.clone(),
        })
        .unwrap();
        filetime::set_file_mtime(&file, filetime::FileTime::from_unix_time(123, 0)).unwrap();
        let baseline = BaselineDb::open(&fixture.paths.baseline_db).unwrap();
        let ctx = UpdateContext {
            root: &fixture.root,
            paths: &fixture.paths,
            config: &fixture.config,
            baseline: &baseline,
        };

        let outcome = update_path(&ctx, "/etc/hello.txt").unwrap();

        assert_eq!(outcome, UpdateOutcome::Pruned);
        assert!(
            crate::metadata::load(&fixture.paths.metadata_file)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn missing_baseline_file_creates_removed_marker() {
        let fixture = Fixture::new();
        fs::remove_file(fixture.root.join("etc/hello.txt")).unwrap();

        let outcome = update_path(&fixture.ctx(), "/etc/hello.txt").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedRemoved);
        assert!(fixture.paths.removed_dir.join("etc/hello.txt").exists());
        assert!(!fixture.paths.changed_dir.join("etc/hello.txt").exists());
    }

    #[test]
    fn missing_new_file_prunes_without_tombstone() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.changed_dir.join("workspace")).unwrap();
        fs::write(fixture.paths.changed_dir.join("workspace/new.txt"), "stale").unwrap();

        let outcome = update_path(&fixture.ctx(), "/workspace/new.txt").unwrap();

        assert_eq!(outcome, UpdateOutcome::Pruned);
        assert!(!fixture.paths.changed_dir.join("workspace/new.txt").exists());
        assert!(!fixture.paths.removed_dir.join("workspace/new.txt").exists());
    }

    #[test]
    fn new_file_is_captured() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("new.txt"), "new").unwrap();

        let outcome = update_path(&fixture.ctx(), "/new.txt").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedChanged);
        assert_eq!(
            fs::read_to_string(fixture.paths.changed_dir.join("new.txt")).unwrap(),
            "new"
        );
    }

    #[test]
    fn changed_symlink_is_captured_losslessly() {
        let fixture = Fixture::new();
        fs::remove_file(fixture.root.join("etc/hello-link")).unwrap();
        symlink("/new-target", fixture.root.join("etc/hello-link")).unwrap();

        let outcome = update_path(&fixture.ctx(), "/etc/hello-link").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedChanged);
        assert_eq!(
            fs::read_link(fixture.paths.changed_dir.join("etc/hello-link")).unwrap(),
            std::path::PathBuf::from("/new-target")
        );
    }

    #[test]
    fn unchanged_baseline_hardlink_does_not_false_positive_on_image_inodes() {
        let fixture = Fixture::new();

        let outcome = update_path(&fixture.ctx(), "/etc/hard-a").unwrap();

        assert_eq!(outcome, UpdateOutcome::Pruned);
        assert!(!fixture.paths.changed_dir.join("etc/hard-a").exists());
    }

    #[test]
    fn broken_baseline_hardlink_is_captured_with_equal_content() {
        let fixture = Fixture::new();
        fs::remove_file(fixture.root.join("etc/hard-b")).unwrap();
        fs::write(fixture.root.join("etc/hard-b"), "shared").unwrap();

        let outcome = update_path(&fixture.ctx(), "/etc/hard-a").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedChanged);
        assert_eq!(
            fs::read_to_string(fixture.paths.changed_dir.join("etc/hard-a")).unwrap(),
            "shared"
        );
    }

    #[test]
    fn new_hardlink_to_baseline_file_is_captured() {
        let fixture = Fixture::new();
        fs::hard_link(
            fixture.root.join("etc/hello.txt"),
            fixture.root.join("hello-hardlink"),
        )
        .unwrap();

        let outcome = update_path(&fixture.ctx(), "/etc/hello.txt").unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedChanged);
        assert!(fixture.paths.changed_dir.join("etc/hello.txt").exists());
        assert_eq!(
            crate::metadata::load(&fixture.paths.metadata_file)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn non_utf8_new_file_is_captured_without_lossy_identity() {
        let fixture = Fixture::new();
        let name = OsString::from_vec(vec![b'b', b'a', b'd', 0xff]);
        fs::write(fixture.root.join(&name), "new").unwrap();
        let public_path = crate::public::PublicPath::from_absolute_bytes(b"/bad\xff").unwrap();

        let outcome = super::update_public_path(&fixture.ctx(), &public_path).unwrap();

        assert_eq!(outcome, UpdateOutcome::PersistedChanged);
        assert_eq!(
            fs::read(fixture.paths.changed_dir.join(name)).unwrap(),
            b"new"
        );
    }

    #[test]
    fn excluded_path_is_ignored() {
        let fixture = Fixture::new();

        let outcome = update_path(&fixture.ctx(), "/data/ignored").unwrap();

        assert_eq!(outcome, UpdateOutcome::Ignored);
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        root: std::path::PathBuf,
        paths: Paths,
        baseline: BaselineDb,
        config: Config,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("root");
            let data = temp.path().join("data/persistd");
            let run = temp.path().join("run/persistd");
            let opt = root.join("opt/persistd");
            let baseline = opt.join("baseline.sqlite");

            fs::create_dir_all(root.join("etc")).unwrap();
            fs::create_dir_all(&opt).unwrap();
            fs::write(root.join("etc/hello.txt"), "hello").unwrap();
            symlink("/etc/hello.txt", root.join("etc/hello-link")).unwrap();
            fs::write(root.join("etc/hard-a"), "shared").unwrap();
            fs::hard_link(root.join("etc/hard-a"), root.join("etc/hard-b")).unwrap();

            generate(&GenerateOptions {
                root: root.clone(),
                output: baseline.clone(),
            })
            .unwrap();

            let paths = Paths::new(opt, run, data);
            layout::ensure(&paths).unwrap();
            let baseline = BaselineDb::open(&baseline).unwrap();

            Self {
                _temp: temp,
                root,
                paths,
                baseline,
                config: Config::default(),
            }
        }

        fn ctx(&self) -> UpdateContext<'_> {
            UpdateContext {
                root: &self.root,
                paths: &self.paths,
                config: &self.config,
                baseline: &self.baseline,
            }
        }
    }
}
