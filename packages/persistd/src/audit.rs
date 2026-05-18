#![cfg(unix)]

use anyhow::{Context, Result};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use walkdir::WalkDir;

use crate::{
    baseline::BaselineDb,
    config::Config,
    paths::Paths,
    update::{UpdateContext, update_path},
};

pub struct Auditor {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Auditor {
    pub fn start(root: PathBuf, paths: Paths, config: Config) -> Result<Self> {
        BaselineDb::open(&paths.baseline_db)?;

        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread = thread::Builder::new()
            .name("persistd-audit".into())
            .spawn(move || {
                if let Err(error) = run_loop(root, paths, config, thread_stop) {
                    tracing::error!(error = %error, "auditor stopped");
                }
            })
            .context("spawn auditor thread")?;

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

fn run_loop(root: PathBuf, paths: Paths, config: Config, stop: Arc<AtomicBool>) -> Result<()> {
    let baseline = BaselineDb::open(&paths.baseline_db)?;
    while !stop.load(Ordering::Relaxed) {
        if let Err(error) = run_once(&root, &paths, &config, &baseline, &stop) {
            tracing::warn!(error = %error, "rolling audit pass failed");
        }
        sleep_interruptibly(Duration::from_secs(5), &stop);
    }
    Ok(())
}

pub fn run_once(
    root: &Path,
    paths: &Paths,
    config: &Config,
    baseline: &BaselineDb,
    stop: &AtomicBool,
) -> Result<()> {
    let update_context = UpdateContext {
        root,
        paths,
        config,
        baseline,
    };

    let mut seen = BTreeSet::new();
    let mut work_started = Instant::now();
    let budget = Duration::from_millis(config.audit.max_work_ms_per_tick.max(1));

    for entry in WalkDir::new(root)
        .follow_links(false)
        .same_file_system(true)
    {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        let entry = entry?;
        if entry.path() == root {
            continue;
        }
        let public = public_path(root, entry.path())?;
        if is_excluded(&public, config) {
            continue;
        }
        seen.insert(public.clone());
        if let Err(error) = update_path(&update_context, &public) {
            tracing::warn!(error = %error, path = public, "audit update failed");
        }
        throttle_if_needed(&mut work_started, budget, stop);
    }

    for public in baseline.all_paths()? {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        if is_excluded(&public, config) || seen.contains(&public) {
            continue;
        }
        if fs::symlink_metadata(root.join(public.trim_start_matches('/'))).is_ok() {
            continue;
        }
        if let Err(error) = update_path(&update_context, &public) {
            tracing::warn!(error = %error, path = public, "audit deletion update failed");
        }
        throttle_if_needed(&mut work_started, budget, stop);
    }

    Ok(())
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

fn public_path(root: &Path, path: &Path) -> Result<String> {
    let relative = path
        .strip_prefix(root)
        .with_context(|| format!("path escaped root: {}", path.display()))?;
    Ok(format!(
        "/{}",
        relative.to_string_lossy().replace('\\', "/")
    ))
}

fn is_excluded(path: &str, config: &Config) -> bool {
    config.exclusions.iter().any(|excluded| {
        path == excluded
            || path
                .strip_prefix(excluded)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

#[cfg(test)]
mod tests {
    use super::run_once;
    use crate::{
        baseline::{BaselineDb, GenerateOptions, generate},
        config::Config,
        layout,
        paths::Paths,
    };
    use std::{fs, sync::atomic::AtomicBool};

    #[test]
    fn audit_captures_missed_file_change() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("etc/hello.txt"), "changed").unwrap();

        run_once(
            &fixture.root,
            &fixture.paths,
            &Config::default(),
            &fixture.baseline,
            &AtomicBool::new(false),
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(fixture.paths.changed_dir.join("etc/hello.txt")).unwrap(),
            "changed"
        );
    }

    #[test]
    fn audit_discovers_deleted_baseline_file() {
        let fixture = Fixture::new();
        fs::remove_file(fixture.root.join("etc/hello.txt")).unwrap();

        run_once(
            &fixture.root,
            &fixture.paths,
            &Config::default(),
            &fixture.baseline,
            &AtomicBool::new(false),
        )
        .unwrap();

        assert!(fixture.paths.removed_dir.join("etc/hello.txt").exists());
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        root: std::path::PathBuf,
        paths: Paths,
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
                paths,
                baseline,
            }
        }
    }
}
