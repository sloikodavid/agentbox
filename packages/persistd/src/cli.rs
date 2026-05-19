use anyhow::{Result, bail};
use clap::{Parser, Subcommand};

use std::path::Path;

#[cfg(unix)]
use crate::apply;
use crate::{config, control, daemon, doctor, internal, layout, paths::Paths, prune, status};

#[derive(Debug, Parser)]
#[command(name = "persistd", about = "Root filesystem persistence daemon")]
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
    let config = config::load_or_create(&paths.config_file)?;
    #[cfg(unix)]
    apply::apply_public_truth(Path::new("/"), paths, &config)?;
    db.record_phase_success("apply")?;
    tracing::info!("persistd apply scaffold completed");
    Ok(())
}

fn daemon_command(paths: &Paths, name: &str, json: bool) -> Result<()> {
    if !paths.control_socket.exists() {
        bail!(
            "persistd {name}: daemon is not running; expected control socket at {}",
            paths.control_socket.display()
        );
    }

    match name {
        "status" => {
            let report: status::StatusReport =
                control::request(&paths.control_socket, control::Command::Status)?;
            print_report(&report, json, status::print_human)
        }
        "doctor" => {
            let report: doctor::DoctorReport =
                control::request(&paths.control_socket, control::Command::Doctor)?;
            print_report(&report, json, doctor::print_human)
        }
        "prune" => {
            let report: prune::PruneReport =
                control::request(&paths.control_socket, control::Command::Prune)?;
            print_report(&report, json, prune::print_human)
        }
        _ => bail!("unknown daemon command {name}"),
    }
}

fn print_report<T: serde::Serialize>(
    report: &T,
    json: bool,
    print_human: impl FnOnce(&T),
) -> Result<()> {
    if json {
        serde_json::to_writer_pretty(std::io::stdout(), report)?;
        println!();
    } else {
        print_human(report);
    }
    Ok(())
}
