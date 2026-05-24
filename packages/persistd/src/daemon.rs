use anyhow::{Context, Result};

#[cfg(unix)]
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::{UnixListener, UnixStream},
    path::PathBuf,
    sync::{Arc, atomic::AtomicU64, mpsc},
    thread,
    time::Duration,
};

use crate::{config, control, doctor, internal, layout, paths::Paths, prune, readiness, status};

#[cfg(unix)]
use crate::{
    audit,
    baseline::BaselineDb,
    capabilities, dirty,
    lifecycle::{LifecycleState, LifecycleStatus},
    public::PublicPath,
    update, watch,
};

#[cfg(unix)]
enum WriterCommand {
    Status(mpsc::Sender<Result<status::StatusReport, String>>),
    Doctor(mpsc::Sender<Result<doctor::DoctorReport, String>>),
    Prune(mpsc::Sender<Result<prune::PruneReport, String>>),
}

#[cfg(unix)]
struct WriterRuntime {
    root: PathBuf,
    paths: Paths,
    config: config::Config,
    baseline: BaselineDb,
    db: internal::StateDb,
    dirty_pending: Arc<AtomicU64>,
    watch_status: LifecycleStatus,
    audit_status: LifecycleStatus,
}

#[cfg(unix)]
pub fn run(paths: &Paths) -> Result<()> {
    layout::remove_ready(paths)?;
    layout::ensure(paths)?;
    let _lock = internal::WriterLock::acquire(paths)?;
    remove_stale_control_socket(paths)?;

    let db = internal::StateDb::open_or_rebuild(paths)?;
    let config = config::load_or_create(&paths.config_file)?;
    let baseline = BaselineDb::open(&paths.baseline_db)
        .with_context(|| format!("daemon requires baseline {}", paths.baseline_db.display()))?;
    let capability_report = capabilities::probe(&paths.data_dir)?;
    db.record_diagnostic("capabilities", &serde_json::to_string(&capability_report)?)?;

    let baseline_records = baseline.all_records()?;
    let (writer_tx, writer_rx) = mpsc::channel();
    let (dirty_tx, dirty_rx) = mpsc::channel();
    let dirty_pending = Arc::new(AtomicU64::new(0));
    let dirty_sender = dirty::DirtySender::new(dirty_tx, Arc::clone(&dirty_pending));
    let watch_status = LifecycleStatus::new(LifecycleState::Initializing);
    let audit_status = LifecycleStatus::new(LifecycleState::Initializing);
    let writer_paths = paths.clone();
    let writer_config = config.clone();
    let writer_watch_status = watch_status.clone();
    let writer_audit_status = audit_status.clone();
    let writer = thread::Builder::new()
        .name("persistd-writer".into())
        .spawn(move || {
            writer_loop(
                WriterRuntime {
                    root: PathBuf::from("/"),
                    paths: writer_paths,
                    config: writer_config,
                    baseline,
                    db,
                    dirty_pending: Arc::clone(&dirty_pending),
                    watch_status: writer_watch_status,
                    audit_status: writer_audit_status,
                },
                writer_rx,
                dirty_rx,
            );
        })
        .context("spawn writer thread")?;

    let _watcher = match watch::Watcher::start(
        PathBuf::from("/"),
        config.clone(),
        dirty_sender.clone(),
        watch_status.clone(),
        paths.watch_error_log.clone(),
    ) {
        Ok(watcher) => watcher,
        Err(error) => {
            let _ = internal::write_error_log(&paths.watch_error_log, &format!("{error:#}"));
            return Err(error).context("initialize watcher");
        }
    };
    let _auditor = audit::Auditor::start(
        PathBuf::from("/"),
        baseline_records,
        config,
        dirty_sender,
        audit_status.clone(),
    )
    .context("initialize auditor")?;

    request_unit(&writer_tx, WriterCommand::Status).context("verify writer status")?;
    let listener = UnixListener::bind(&paths.control_socket)
        .with_context(|| format!("bind {}", paths.control_socket.display()))?;
    listener
        .set_nonblocking(true)
        .context("set control socket nonblocking")?;

    let db = internal::StateDb::open_or_rebuild(paths)?;
    db.record_phase_success("daemon")?;
    db.record_diagnostic("watch_status", &watch_status.text())?;
    db.record_diagnostic("audit_status", &audit_status.text())?;
    db.record_diagnostic("capabilities", &serde_json::to_string(&capability_report)?)?;
    readiness::write_ready(paths, "daemon")?;
    tracing::info!("persistd daemon is ready");

    loop {
        match listener.accept() {
            Ok((stream, _addr)) => {
                if let Err(error) = handle_control_stream(stream, &writer_tx) {
                    tracing::warn!(error = %error, "control request failed");
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if writer.is_finished() {
                    anyhow::bail!("persistd writer stopped");
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(error).context("accept control connection"),
        }
    }
}

#[cfg(not(unix))]
pub fn run(_paths: &Paths) -> Result<()> {
    anyhow::bail!("persistd daemon is only supported on Unix");
}

#[cfg(unix)]
fn writer_loop(
    runtime: WriterRuntime,
    command_rx: mpsc::Receiver<WriterCommand>,
    dirty_rx: mpsc::Receiver<PublicPath>,
) {
    let update_context = update::UpdateContext {
        root: &runtime.root,
        paths: &runtime.paths,
        config: &runtime.config,
        baseline: &runtime.baseline,
    };

    loop {
        let mut public_index_dirty = false;
        for _ in 0..256 {
            let Ok(public_path) = dirty_rx.try_recv() else {
                break;
            };
            match update::update_public_path(&update_context, &public_path) {
                Ok(update::UpdateOutcome::Ignored) => {}
                Ok(_) => {
                    public_index_dirty = true;
                }
                Err(error) => {
                    tracing::warn!(error = %error, path = %public_path, "dirty path update failed");
                    let _ = runtime
                        .db
                        .record_phase_failure("update", &format!("{error:#}"));
                }
            }
            dirty::mark_processed(&runtime.dirty_pending);
        }
        if public_index_dirty {
            let _ = runtime.db.rebuild_public_index(&runtime.paths);
        }

        match command_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(WriterCommand::Status(response)) => {
                let dirty_queue_size = dirty::pending_count(&runtime.dirty_pending);
                let _ = response.send(
                    status::build_with_runtime(
                        &runtime.paths,
                        &runtime.db,
                        status::RuntimeStatus {
                            dirty_queue_size,
                            watch_status: Some(runtime.watch_status.text()),
                            audit_status: Some(runtime.audit_status.text()),
                        },
                    )
                    .map_err(|error| format!("{error:#}")),
                );
            }
            Ok(WriterCommand::Doctor(response)) => {
                let _ = response.send(
                    doctor::run(&runtime.paths, &runtime.db).map_err(|error| format!("{error:#}")),
                );
            }
            Ok(WriterCommand::Prune(response)) => {
                let _ = response.send(
                    prune::run(
                        &runtime.root,
                        &runtime.paths,
                        &runtime.config,
                        &runtime.baseline,
                        &runtime.db,
                    )
                    .map_err(|error| format!("{error:#}")),
                );
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

#[cfg(unix)]
fn remove_stale_control_socket(paths: &Paths) -> Result<()> {
    match std::fs::remove_file(&paths.control_socket) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| {
            format!(
                "remove stale control socket {}",
                paths.control_socket.display()
            )
        }),
    }
}

#[cfg(unix)]
fn handle_control_stream(
    mut stream: UnixStream,
    writer_tx: &mpsc::Sender<WriterCommand>,
) -> Result<()> {
    let mut line = String::new();
    BufReader::new(stream.try_clone().context("clone control stream")?)
        .read_line(&mut line)
        .context("read control request")?;

    let response = match serde_json::from_str::<control::Request>(&line) {
        Ok(request) if request.version == 1 => handle_control_request(request.command, writer_tx)
            .unwrap_or_else(control::Response::error),
        Ok(request) => control::Response::error(format!(
            "unsupported control protocol version {}",
            request.version
        )),
        Err(error) => control::Response::error(format!("invalid control request: {error}")),
    };

    serde_json::to_writer(&mut stream, &response).context("write control response")?;
    stream.write_all(b"\n").context("finish control response")?;
    Ok(())
}

#[cfg(unix)]
fn handle_control_request(
    command: control::Command,
    writer_tx: &mpsc::Sender<WriterCommand>,
) -> Result<control::Response> {
    match command {
        control::Command::Status => {
            let report = request_unit(writer_tx, WriterCommand::Status)?;
            control::Response::ok(&report)
        }
        control::Command::Doctor => {
            let report = request_unit(writer_tx, WriterCommand::Doctor)?;
            control::Response::ok(&report)
        }
        control::Command::Prune => {
            let report = request_unit(writer_tx, WriterCommand::Prune)?;
            control::Response::ok(&report)
        }
    }
}

#[cfg(unix)]
fn request_unit<T: Send + 'static>(
    writer_tx: &mpsc::Sender<WriterCommand>,
    build: impl FnOnce(mpsc::Sender<Result<T, String>>) -> WriterCommand,
) -> Result<T> {
    let (response_tx, response_rx) = mpsc::channel();
    writer_tx
        .send(build(response_tx))
        .context("send writer command")?;
    response_rx
        .recv_timeout(Duration::from_secs(10))
        .context("writer command timed out")?
        .map_err(anyhow::Error::msg)
}

#[cfg(unix)]
#[cfg(test)]
mod tests {
    use super::{WriterCommand, WriterRuntime, handle_control_stream, writer_loop};
    use crate::{
        baseline::{BaselineDb, GenerateOptions, generate},
        config::Config,
        control,
        internal::StateDb,
        layout,
        lifecycle::{LifecycleState, LifecycleStatus},
        paths::Paths,
    };
    use std::{
        fs,
        io::{BufRead, BufReader, Write},
        os::unix::net::UnixStream,
        sync::{Arc, atomic::AtomicU64, mpsc},
        thread,
    };

    #[test]
    fn status_doctor_and_prune_requests_are_served_through_writer() {
        let fixture = Fixture::new();
        let (writer_tx, writer_rx) = mpsc::channel();
        let (_dirty_tx, dirty_rx) = mpsc::channel();
        let dirty_pending = Arc::new(AtomicU64::new(0));
        let root = fixture.root.clone();
        let paths = fixture.paths.clone();
        let baseline = BaselineDb::open(&paths.baseline_db).unwrap();
        let db = StateDb::open_or_rebuild(&paths).unwrap();
        let writer_thread = thread::spawn(move || {
            writer_loop(
                WriterRuntime {
                    root,
                    paths,
                    config: Config::default(),
                    baseline,
                    db,
                    dirty_pending,
                    watch_status: LifecycleStatus::new(LifecycleState::Running),
                    audit_status: LifecycleStatus::new(LifecycleState::Running),
                },
                writer_rx,
                dirty_rx,
            );
        });

        let response = request(&writer_tx, control::Command::Status);
        assert!(response.ok);
        assert!(response.payload.unwrap()["publicCounts"]["changed"].is_number());

        let response = request(&writer_tx, control::Command::Doctor);
        assert!(response.ok);
        assert_eq!(response.payload.unwrap()["rebuiltPublicIndex"], true);

        let response = request(&writer_tx, control::Command::Prune);
        assert!(response.ok);

        drop(writer_tx);
        writer_thread.join().unwrap();
    }

    fn request(
        writer_tx: &mpsc::Sender<WriterCommand>,
        command: control::Command,
    ) -> control::Response {
        let (mut client, server) = UnixStream::pair().unwrap();
        let writer_tx = writer_tx.clone();
        let server_thread = thread::spawn(move || {
            handle_control_stream(server, &writer_tx).unwrap();
        });

        serde_json::to_writer(
            &mut client,
            &control::Request {
                version: 1,
                command,
            },
        )
        .unwrap();
        client.write_all(b"\n").unwrap();
        let mut line = String::new();
        BufReader::new(client).read_line(&mut line).unwrap();
        server_thread.join().unwrap();

        serde_json::from_str(&line).unwrap()
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
                root.join("opt/persistd"),
                temp.path().join("run/persistd"),
                temp.path().join("data/persistd"),
            );
            fs::create_dir_all(root.join("opt/persistd")).unwrap();
            fs::create_dir_all(root.join("etc")).unwrap();
            fs::write(root.join("etc/hello"), "hello").unwrap();
            generate(&GenerateOptions {
                root: root.clone(),
                output: paths.baseline_db.clone(),
            })
            .unwrap();
            layout::ensure(&paths).unwrap();
            Self {
                _temp: temp,
                root,
                paths,
            }
        }
    }
}
