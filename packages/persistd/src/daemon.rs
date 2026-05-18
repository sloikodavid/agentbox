use anyhow::Result;
use std::{thread, time::Duration};

use crate::{internal, layout, paths::Paths, readiness};

pub fn run(paths: &Paths) -> Result<()> {
    layout::remove_ready(paths)?;
    layout::ensure(paths)?;
    internal::assert_daemon_not_running(paths)?;
    let _lock = internal::WriterLock::acquire(paths)?;
    let db = internal::StateDb::open_or_rebuild(paths)?;
    db.record_phase_success("daemon")?;

    readiness::write_ready(paths, "daemon")?;
    tracing::info!("persistd daemon scaffold is ready");

    loop {
        thread::sleep(Duration::from_secs(3600));
    }
}
