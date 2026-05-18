use anyhow::Result;
use std::{path::PathBuf, thread, time::Duration};

use crate::{config, internal, layout, paths::Paths, readiness};

#[cfg(unix)]
use crate::{audit, watch};

pub fn run(paths: &Paths) -> Result<()> {
    layout::remove_ready(paths)?;
    layout::ensure(paths)?;
    internal::assert_daemon_not_running(paths)?;
    let _lock = internal::WriterLock::acquire(paths)?;
    let db = internal::StateDb::open_or_rebuild(paths)?;
    let config = config::load_or_create(&paths.config_file)?;

    #[cfg(unix)]
    let _watcher = watch::Watcher::start(PathBuf::from("/"), paths.clone(), config.clone())?;
    #[cfg(unix)]
    let _auditor = audit::Auditor::start(PathBuf::from("/"), paths.clone(), config)?;

    db.record_phase_success("daemon")?;

    readiness::write_ready(paths, "daemon")?;
    tracing::info!("persistd daemon is ready");

    loop {
        thread::sleep(Duration::from_secs(3600));
    }
}
