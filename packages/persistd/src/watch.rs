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
    config::Config,
    dirty::DirtySender,
    internal,
    lifecycle::{LifecycleState, LifecycleStatus},
    public::PublicPath,
};

pub struct Watcher {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Watcher {
    pub fn start(
        root: PathBuf,
        config: Config,
        dirty_tx: DirtySender,
        lifecycle: LifecycleStatus,
        error_log: PathBuf,
    ) -> Result<Self> {
        lifecycle.set(LifecycleState::Initializing);
        initialize(&root, &config)?;

        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("persistd-watch".into())
            .spawn(move || {
                if let Err(error) = run_loop(
                    root,
                    config,
                    dirty_tx,
                    lifecycle.clone(),
                    error_log.clone(),
                    thread_stop,
                    ready_tx,
                ) {
                    lifecycle.set(LifecycleState::Stopped);
                    let _ = internal::write_error_log(&error_log, &format!("{error:#}"));
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

fn initialize(root: &Path, config: &Config) -> Result<()> {
    let mut inotify = Inotify::init().context("initialize inotify")?;
    let mut watches = HashMap::new();
    register_existing_dirs(&mut inotify, &mut watches, root, root, config)?;
    Ok(())
}

fn run_loop(
    root: PathBuf,
    config: Config,
    dirty_tx: DirtySender,
    lifecycle: LifecycleStatus,
    error_log: PathBuf,
    stop: Arc<AtomicBool>,
    ready: mpsc::Sender<()>,
) -> Result<()> {
    let mut inotify = Inotify::init().context("initialize inotify")?;
    let mut watches = HashMap::new();
    register_existing_dirs(&mut inotify, &mut watches, &root, &root, &config)?;
    let mut buffer = vec![0; 16 * 1024];
    lifecycle.set(LifecycleState::Running);
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
                let message = "inotify event queue overflowed; rolling audit will recover";
                lifecycle.set(LifecycleState::Degraded);
                let _ = internal::write_error_log(&error_log, message);
                tracing::warn!("{message}");
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
                    let _ = dirty_tx.send(public);
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
    let mut entries = WalkDir::new(start).follow_links(false).into_iter();
    while let Some(entry) = entries.next() {
        let entry = entry?;
        if !entry.file_type().is_dir() {
            continue;
        }
        if entry.path() != root {
            let public = public_path(root, entry.path())?;
            if crate::public::is_excluded(&public, config) {
                entries.skip_current_dir();
                continue;
            }
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

pub fn public_path(root: &Path, path: &Path) -> Result<PublicPath> {
    let relative = path
        .strip_prefix(root)
        .with_context(|| format!("path escaped root: {}", path.display()))?;
    PublicPath::from_root_relative(relative)
}

#[cfg(test)]
mod tests {
    use super::{Watcher, public_path};
    use crate::{
        config::Config,
        lifecycle::{LifecycleState, LifecycleStatus},
    };
    use std::{
        fs,
        sync::{Arc, atomic::AtomicU64, mpsc},
        thread,
        time::Duration,
    };

    #[test]
    fn watcher_emits_file_change_candidate() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        fs::create_dir_all(root.join("etc")).unwrap();
        fs::write(root.join("etc/hello.txt"), "hello").unwrap();
        let (tx, rx) = mpsc::channel();
        let dirty_tx = crate::dirty::DirtySender::new(tx, Arc::new(AtomicU64::new(0)));
        let lifecycle = LifecycleStatus::new(LifecycleState::Initializing);
        let _watcher = Watcher::start(
            root.clone(),
            Config::default(),
            dirty_tx,
            lifecycle.clone(),
            temp.path().join("watch-error.log"),
        )
        .unwrap();
        assert_eq!(lifecycle.get(), LifecycleState::Running);

        fs::write(root.join("etc/hello.txt"), "changed").unwrap();

        let public = wait_for_candidate(rx);
        assert_eq!(public.as_bytes(), b"/etc/hello.txt");
    }

    #[test]
    fn public_path_preserves_root_relative_unix_bytes() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("etc")).unwrap();
        assert_eq!(
            public_path(root.path(), &root.path().join("etc/hosts"))
                .unwrap()
                .as_bytes(),
            b"/etc/hosts"
        );
    }

    fn wait_for_candidate(
        rx: mpsc::Receiver<crate::public::PublicPath>,
    ) -> crate::public::PublicPath {
        for _ in 0..50 {
            if let Ok(path) = rx.recv_timeout(Duration::from_millis(100)) {
                return path;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("candidate was not emitted");
    }
}
