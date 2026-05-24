use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};

use std::path::PathBuf;

#[cfg(unix)]
use crate::apply;
#[cfg(unix)]
use crate::baseline::{GenerateOptions, generate};
#[cfg(unix)]
use crate::capabilities;
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
    /// Internal image-build command. Not part of the runtime command surface.
    #[command(name = "__generate-baseline", hide = true)]
    GenerateBaseline {
        #[arg(long, default_value = "/")]
        root: PathBuf,
        #[arg(long, default_value = "/opt/persistd/baseline.sqlite")]
        output: PathBuf,
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
        #[cfg(unix)]
        Command::GenerateBaseline { root, output } => generate(&GenerateOptions { root, output }),
    }
}

fn run_apply(paths: &Paths) -> Result<()> {
    layout::remove_ready(paths)?;
    layout::ensure(paths)?;
    let _lock = internal::WriterLock::acquire(paths)?;
    let db = internal::StateDb::open_or_rebuild(paths)?;
    match run_apply_inner(paths, &db) {
        Ok(()) => {
            db.record_phase_success("apply")?;
            tracing::info!("persistd apply completed");
            Ok(())
        }
        Err(error) => {
            let summary = format!("{error:#}");
            let _ = db.record_phase_failure("apply", &summary);
            let _ = internal::write_error_log(&paths.apply_error_log, &summary);
            Err(error)
        }
    }
}

fn run_apply_inner(paths: &Paths, db: &internal::StateDb) -> Result<()> {
    let config = config::load_or_create(&paths.config_file)?;
    let _baseline = crate::baseline::BaselineDb::open(&paths.baseline_db)
        .with_context(|| format!("apply requires baseline {}", paths.baseline_db.display()))?;
    let capability_report = capabilities::probe(&paths.data_dir)?;
    db.record_diagnostic("capabilities", &serde_json::to_string(&capability_report)?)?;
    crate::metadata::compact(&paths.metadata_file)?;
    #[cfg(unix)]
    apply::apply_public_truth(std::path::Path::new("/"), paths, &config)?;
    db.rebuild_public_index(paths)?;
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

#[cfg(all(test, unix))]
mod tests {
    use super::run_apply;
    use crate::{baseline, internal::StateDb, paths::Paths};
    use std::fs;

    #[test]
    fn apply_fails_without_baseline_and_records_diagnostics() {
        let fixture = Fixture::new();
        fs::create_dir_all(&fixture.paths.run_dir).unwrap();
        fs::write(&fixture.paths.ready_file, "stale").unwrap();

        let error = run_apply(&fixture.paths).unwrap_err().to_string();

        assert!(error.contains("baseline"));
        assert!(!fixture.paths.ready_file.exists());
        assert!(fixture.paths.apply_error_log.exists());
        let db = StateDb::open_or_rebuild(&fixture.paths).unwrap();
        assert!(
            db.meta_value("last_apply_error")
                .unwrap()
                .unwrap()
                .contains("baseline")
        );
    }

    #[test]
    fn apply_fails_with_corrupt_baseline_and_does_not_write_ready() {
        let fixture = Fixture::new();
        fs::create_dir_all(&fixture.paths.opt_dir).unwrap();
        fs::write(&fixture.paths.baseline_db, "not sqlite").unwrap();

        let error = run_apply(&fixture.paths).unwrap_err().to_string();

        assert!(error.contains("baseline"));
        assert!(!fixture.paths.ready_file.exists());
        assert!(
            fs::read_to_string(&fixture.paths.apply_error_log)
                .unwrap()
                .contains("baseline")
        );
    }

    #[test]
    fn apply_success_rebuilds_public_index() {
        let fixture = Fixture::new();
        fs::create_dir_all(&fixture.paths.opt_dir).unwrap();
        baseline::generate(&baseline::GenerateOptions {
            root: fixture.root.clone(),
            output: fixture.paths.baseline_db.clone(),
        })
        .unwrap();
        fs::create_dir_all(fixture.paths.changed_dir.join("tmp")).unwrap();
        fs::write(fixture.paths.changed_dir.join("tmp/persisted"), "value").unwrap();

        run_apply(&fixture.paths).unwrap();

        let db = StateDb::open_or_rebuild(&fixture.paths).unwrap();
        assert_eq!(db.public_count("changed").unwrap(), 2);
        assert!(db.meta_value("last_apply_success_at").unwrap().is_some());
        assert!(!fixture.paths.ready_file.exists());
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        root: std::path::PathBuf,
        paths: Paths,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("root");
            let paths = Paths::new(
                temp.path().join("opt/persistd"),
                temp.path().join("run/persistd"),
                temp.path().join("data/persistd"),
            );
            fs::create_dir_all(&root).unwrap();
            Self {
                _temp: temp,
                root,
                paths,
            }
        }
    }
}
