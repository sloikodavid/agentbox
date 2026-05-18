#![cfg(unix)]

use anyhow::{Context, Result};
use inotify::{EventMask, Inotify, WatchDescriptor, WatchMask};
use std::{
    collections::HashMap,
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use walkdir::WalkDir;

use crate::{
    baseline::BaselineDb,
    config::Config,
    paths::Paths,
    update::{UpdateContext, update_path},
};

pub struct Watcher {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Watcher {
    pub fn start(root: PathBuf, paths: Paths, config: Config) -> Result<Self> {
        initialize(&root, &paths, &config)?;

        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("persistd-watch".into())
            .spawn(move || {
                if let Err(error) = run_loop(root, paths, config, thread_stop, ready_tx) {
                    tracing::error!(error = %error, "watcher stopped");
                }
            })
            .context("spawn watcher thread")?;
        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .context("watcher did not initialize")?;

        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.thread.take();
    }
}

fn initialize(root: &Path, paths: &Paths, config: &Config) -> Result<()> {
    let mut inotify = Inotify::init().context("initialize inotify")?;
    let mut watches = HashMap::new();
    register_existing_dirs(&mut inotify, &mut watches, root, root, config)?;
    BaselineDb::open(&paths.baseline_db)?;
    Ok(())
}

fn run_loop(
    root: PathBuf,
    paths: Paths,
    config: Config,
    stop: Arc<AtomicBool>,
    ready: mpsc::Sender<()>,
) -> Result<()> {
    let mut inotify = Inotify::init().context("initialize inotify")?;
    let mut watches = HashMap::new();
    register_existing_dirs(&mut inotify, &mut watches, &root, &root, &config)?;
    let baseline = BaselineDb::open(&paths.baseline_db)?;
    let update_context = UpdateContext {
        root: &root,
        paths: &paths,
        config: &config,
        baseline: &baseline,
    };
    let mut buffer = vec![0; 16 * 1024];
    let _ = ready.send(());

    while !stop.load(Ordering::Relaxed) {
        let events = inotify
            .read_events_blocking(&mut buffer)
            .context("read inotify events")?;

        for event in events {
            if event.mask.contains(EventMask::IGNORED) {
                watches.remove(&event.wd);
                continue;
            }
            if event.mask.contains(EventMask::Q_OVERFLOW) {
                tracing::warn!("inotify event queue overflowed; rolling audit will recover");
                continue;
            }
            let Some(base) = watches.get(&event.wd) else {
                continue;
            };
            let candidate = event_path(base, event.name);

            if event.mask.contains(EventMask::ISDIR)
                && event
                    .mask
                    .intersects(EventMask::CREATE | EventMask::MOVED_TO)
                && let Err(error) =
                    register_existing_dirs(&mut inotify, &mut watches, &root, &candidate, &config)
            {
                tracing::warn!(error = %error, path = %candidate.display(), "failed to watch new directory");
            }

            match public_path(&root, &candidate) {
                Ok(public) => {
                    if let Err(error) = update_path(&update_context, &public) {
                        tracing::warn!(error = %error, path = public, "failed to update dirty path");
                    }
                }
                Err(error) => {
                    tracing::warn!(error = %error, path = %candidate.display(), "ignored invalid watch path")
                }
            }
        }
    }

    Ok(())
}

fn register_existing_dirs(
    inotify: &mut Inotify,
    watches: &mut HashMap<WatchDescriptor, PathBuf>,
    root: &Path,
    start: &Path,
    config: &Config,
) -> Result<()> {
    for entry in WalkDir::new(start).follow_links(false) {
        let entry = entry?;
        if !entry.file_type().is_dir() {
            continue;
        }
        let public = public_path(root, entry.path())?;
        if public != "/" && is_excluded(&public, config) {
            continue;
        }
        let descriptor = inotify
            .watches()
            .add(
                entry.path(),
                WatchMask::CREATE
                    | WatchMask::MODIFY
                    | WatchMask::DELETE
                    | WatchMask::DELETE_SELF
                    | WatchMask::MOVED_FROM
                    | WatchMask::MOVED_TO
                    | WatchMask::ATTRIB
                    | WatchMask::CLOSE_WRITE,
            )
            .with_context(|| format!("watch {}", entry.path().display()))?;
        watches.insert(descriptor, entry.path().to_path_buf());
    }
    Ok(())
}

fn event_path(base: &Path, name: Option<&OsStr>) -> PathBuf {
    match name {
        Some(name) => base.join(name),
        None => base.to_path_buf(),
    }
}

fn public_path(root: &Path, path: &Path) -> Result<String> {
    if path == root {
        return Ok("/".into());
    }
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
    use super::{Watcher, public_path};
    use crate::{
        baseline::{BaselineDb, GenerateOptions, generate},
        config::Config,
        layout,
        paths::Paths,
    };
    use std::{fs, thread, time::Duration};

    #[test]
    fn watcher_captures_file_change() {
        let fixture = Fixture::new();
        let _watcher = Watcher::start(
            fixture.root.clone(),
            fixture.paths.clone(),
            Config::default(),
        )
        .unwrap();

        fs::write(fixture.root.join("etc/hello.txt"), "changed").unwrap();

        wait_until(|| fixture.paths.changed_dir.join("etc/hello.txt").exists());
    }

    #[test]
    fn public_path_formats_root_relative_unix_paths() {
        let root = std::path::Path::new("/tmp/root");
        assert_eq!(
            public_path(root, std::path::Path::new("/tmp/root/etc/hosts")).unwrap(),
            "/etc/hosts"
        );
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        root: std::path::PathBuf,
        paths: Paths,
        _baseline: BaselineDb,
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
                _baseline: baseline,
            }
        }
    }

    fn wait_until(mut condition: impl FnMut() -> bool) {
        for _ in 0..50 {
            if condition() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        panic!("condition did not become true");
    }
}
