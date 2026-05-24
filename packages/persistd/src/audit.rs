#![cfg(unix)]

use anyhow::{Context, Result};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use walkdir::WalkDir;

use crate::{
    baseline::BaselineRecord,
    config::Config,
    dirty::DirtySender,
    lifecycle::{LifecycleState, LifecycleStatus},
    public::PublicPath,
    rootfs::{self, FileKind, FsFacts},
    update,
};

pub struct Auditor {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Auditor {
    pub fn start(
        root: PathBuf,
        baseline_records: Vec<BaselineRecord>,
        config: Config,
        dirty_tx: DirtySender,
        lifecycle: LifecycleStatus,
    ) -> Result<Self> {
        lifecycle.set(LifecycleState::Initializing);
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("persistd-audit".into())
            .spawn(move || {
                lifecycle.set(LifecycleState::Running);
                let _ = ready_tx.send(());
                if let Err(error) = run_loop(
                    root,
                    baseline_records,
                    config,
                    dirty_tx,
                    lifecycle.clone(),
                    thread_stop,
                ) {
                    lifecycle.set(LifecycleState::Stopped);
                    tracing::error!(error = %error, "auditor stopped");
                }
            })
            .context("spawn auditor thread")?;
        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .context("auditor did not initialize")?;

        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
}

impl Drop for Auditor {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.thread.take();
    }
}

fn run_loop(
    root: PathBuf,
    baseline_records: Vec<BaselineRecord>,
    config: Config,
    dirty_tx: DirtySender,
    lifecycle: LifecycleStatus,
    stop: Arc<AtomicBool>,
) -> Result<()> {
    let baseline = baseline_records
        .into_iter()
        .map(|record| (record.path.clone(), record))
        .collect::<BTreeMap<_, _>>();
    while !stop.load(Ordering::Relaxed) {
        if let Err(error) = run_once(&root, &baseline, &config, &dirty_tx, &stop) {
            lifecycle.set(LifecycleState::Degraded);
            tracing::warn!(error = %error, "rolling audit pass failed");
        }
        sleep_interruptibly(Duration::from_secs(5), &stop);
    }
    Ok(())
}

pub fn run_once(
    root: &Path,
    baseline: &BTreeMap<PublicPath, BaselineRecord>,
    config: &Config,
    dirty_tx: &DirtySender,
    stop: &AtomicBool,
) -> Result<()> {
    let mut seen = BTreeSet::new();
    let mut work_started = Instant::now();
    let budget = Duration::from_millis(config.audit.max_work_ms_per_tick.max(1));

    let mut entries = WalkDir::new(root).follow_links(false).into_iter();
    while let Some(entry) = entries.next() {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        let entry = entry?;
        if entry.path() == root {
            continue;
        }
        let public = public_path(root, entry.path())?;
        if crate::public::is_excluded(&public, config) {
            if entry.file_type().is_dir() {
                entries.skip_current_dir();
            }
            continue;
        }
        seen.insert(public.clone());
        let facts = rootfs::facts(entry.path())
            .with_context(|| format!("inspect audit candidate {}", entry.path().display()))?;
        if candidate_needs_update(&facts, baseline.get(&public))? {
            let _ = dirty_tx.send(public);
        }
        throttle_if_needed(&mut work_started, budget, stop);
    }

    for public in baseline.keys() {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        if crate::public::is_excluded(public, config) || seen.contains(public) {
            continue;
        }
        let _ = dirty_tx.send(public.clone());
        throttle_if_needed(&mut work_started, budget, stop);
    }

    Ok(())
}

fn candidate_needs_update(live: &FsFacts, baseline: Option<&BaselineRecord>) -> Result<bool> {
    let Some(record) = baseline else {
        return Ok(true);
    };

    if live.kind.as_str() != record.kind
        || i64::from(live.mode) != record.mode
        || i64::from(live.uid) != record.uid
        || i64::from(live.gid) != record.gid
        || !update::mtime_matches_baseline(live.mtime_ns, record.mtime_ns)
        || live.nlink as i64 != record.nlink
    {
        return Ok(true);
    }

    match live.kind {
        FileKind::File => {
            if live.size.map(|size| size as i64) != record.size {
                return Ok(true);
            }
        }
        FileKind::Symlink => {
            if live.symlink_target.as_deref() != record.symlink_target_bytes.as_deref() {
                return Ok(true);
            }
        }
        FileKind::CharDevice | FileKind::BlockDevice => {
            if live.rdev_major.map(|value| value as i64) != record.rdev_major
                || live.rdev_minor.map(|value| value as i64) != record.rdev_minor
            {
                return Ok(true);
            }
        }
        FileKind::Dir | FileKind::Fifo | FileKind::Socket | FileKind::Unknown => {}
    }

    let baseline_xattrs = record
        .xattr_json
        .as_deref()
        .map(serde_json::from_str::<Vec<rootfs::XattrRecord>>)
        .transpose()?
        .unwrap_or_default();
    Ok(live.xattrs != baseline_xattrs)
}

fn throttle_if_needed(work_started: &mut Instant, budget: Duration, stop: &AtomicBool) {
    if work_started.elapsed() < budget {
        return;
    }
    sleep_interruptibly(Duration::from_millis(10), stop);
    *work_started = Instant::now();
}

fn sleep_interruptibly(duration: Duration, stop: &AtomicBool) {
    let started = Instant::now();
    while !stop.load(Ordering::Relaxed) && started.elapsed() < duration {
        thread::sleep(Duration::from_millis(25));
    }
}

fn public_path(root: &Path, path: &Path) -> Result<PublicPath> {
    let relative = path
        .strip_prefix(root)
        .with_context(|| format!("path escaped root: {}", path.display()))?;
    PublicPath::from_root_relative(relative)
}

#[cfg(test)]
mod tests {
    use super::run_once;
    use crate::{
        baseline::{BaselineDb, BaselineRecord, GenerateOptions, generate},
        config::Config,
        layout,
        paths::Paths,
        public::PublicPath,
    };
    use std::{
        collections::BTreeMap,
        fs,
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicU64},
            mpsc,
        },
    };

    #[test]
    fn audit_emits_changed_and_deleted_candidates() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("etc/hello.txt"), "changed").unwrap();
        fs::remove_file(fixture.root.join("etc/delete-me")).unwrap();
        let (tx, rx) = mpsc::channel();
        let dirty_tx = crate::dirty::DirtySender::new(tx, Arc::new(AtomicU64::new(0)));

        run_once(
            &fixture.root,
            &fixture.baseline_map(),
            &Config::default(),
            &dirty_tx,
            &AtomicBool::new(false),
        )
        .unwrap();
        drop(dirty_tx);

        let candidates = rx.try_iter().map(|path| path.display()).collect::<Vec<_>>();
        assert!(candidates.contains(&"/etc/hello.txt".into()));
        assert!(candidates.contains(&"/etc/delete-me".into()));
        assert!(!candidates.contains(&"/etc/unchanged".into()));
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        root: std::path::PathBuf,
        _paths: Paths,
        baseline: BaselineDb,
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
            fs::create_dir_all(&paths.opt_dir).unwrap();
            fs::write(root.join("etc/hello.txt"), "hello").unwrap();
            fs::write(root.join("etc/delete-me"), "bye").unwrap();
            fs::write(root.join("etc/unchanged"), "same").unwrap();
            generate(&GenerateOptions {
                root: root.clone(),
                output: paths.baseline_db.clone(),
            })
            .unwrap();
            layout::ensure(&paths).unwrap();
            let baseline = BaselineDb::open(&paths.baseline_db).unwrap();
            Self {
                _temp: temp,
                root,
                _paths: paths,
                baseline,
            }
        }

        fn baseline_map(&self) -> BTreeMap<PublicPath, BaselineRecord> {
            self.baseline
                .all_records()
                .unwrap()
                .into_iter()
                .map(|record| (record.path.clone(), record))
                .collect()
        }
    }
}
