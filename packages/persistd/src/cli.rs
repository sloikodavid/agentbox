use anyhow::{Result, bail};
use clap::{Parser, Subcommand};

use crate::{daemon, internal, layout, paths::Paths};

#[derive(Debug, Parser)]
#[command(
    name = "persistd",
    about = "Agentbox root filesystem persistence daemon"
)]
pub struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Apply persisted public truth to the live filesystem during boot.
    Apply,
    /// Run the long-lived persistence daemon.
    Daemon,
    /// Print operational daemon status.
    Status {
        /// Emit machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
    /// Ask the daemon to validate and safely repair persistence state.
    Doctor {
        /// Emit machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
    /// Ask the daemon to remove stale public persistence data.
    Prune {
        /// Emit machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
}

pub fn run(args: Args) -> Result<()> {
    let paths = Paths::default();
    match args.command {
        Command::Apply => run_apply(&paths),
        Command::Daemon => daemon::run(&paths),
        Command::Status { json } => daemon_command(&paths, "status", json),
        Command::Doctor { json } => daemon_command(&paths, "doctor", json),
        Command::Prune { json } => daemon_command(&paths, "prune", json),
    }
}

fn run_apply(paths: &Paths) -> Result<()> {
    layout::remove_ready(paths)?;
    layout::ensure(paths)?;
    let _lock = internal::WriterLock::acquire(paths)?;
    let db = internal::StateDb::open_or_rebuild(paths)?;
    db.record_phase_success("apply")?;
    tracing::info!("persistd apply scaffold completed");
    Ok(())
}

fn daemon_command(paths: &Paths, name: &str, _json: bool) -> Result<()> {
    if !paths.control_socket.exists() {
        bail!(
            "persistd {name}: daemon is not running; expected control socket at {}",
            paths.control_socket.display()
        );
    }

    bail!("persistd {name}: control socket protocol is not implemented yet")
}
