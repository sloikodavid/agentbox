use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    pub opt_dir: PathBuf,
    pub baseline_db: PathBuf,
    pub run_dir: PathBuf,
    pub ready_file: PathBuf,
    pub data_dir: PathBuf,
    pub config_file: PathBuf,
    pub changed_dir: PathBuf,
    pub removed_dir: PathBuf,
    pub metadata_file: PathBuf,
    pub internal_dir: PathBuf,
    pub state_db: PathBuf,
    pub lock_file: PathBuf,
    pub control_socket: PathBuf,
    pub apply_error_log: PathBuf,
    pub watch_error_log: PathBuf,
}

impl Default for Paths {
    fn default() -> Self {
        Self::new("/opt/persistd", "/run/persistd", "/data/persistd")
    }
}

impl Paths {
    pub fn new(
        opt_dir: impl Into<PathBuf>,
        run_dir: impl Into<PathBuf>,
        data_dir: impl Into<PathBuf>,
    ) -> Self {
        let opt_dir = opt_dir.into();
        let run_dir = run_dir.into();
        let data_dir = data_dir.into();
        let internal_dir = join(&data_dir, ".internal");

        Self {
            baseline_db: join(&opt_dir, "baseline.sqlite"),
            ready_file: join(&run_dir, "ready"),
            config_file: join(&data_dir, "config.json"),
            changed_dir: join(&data_dir, "changed"),
            removed_dir: join(&data_dir, "removed"),
            metadata_file: join(&data_dir, "metadata.jsonl"),
            state_db: join(&internal_dir, "state.sqlite"),
            lock_file: join(&internal_dir, "lock"),
            control_socket: join(&internal_dir, "control.sock"),
            apply_error_log: join(&internal_dir, "apply-error.log"),
            watch_error_log: join(&internal_dir, "watch-error.log"),
            opt_dir,
            run_dir,
            data_dir,
            internal_dir,
        }
    }
}

fn join(base: &std::path::Path, child: &str) -> PathBuf {
    base.join(child)
}

#[cfg(test)]
mod tests {
    use super::Paths;

    #[test]
    fn default_paths_match_the_public_contract() {
        let paths = Paths::default();

        assert_eq!(
            paths.baseline_db.to_string_lossy(),
            "/opt/persistd/baseline.sqlite"
        );
        assert_eq!(paths.ready_file.to_string_lossy(), "/run/persistd/ready");
        assert_eq!(
            paths.config_file.to_string_lossy(),
            "/data/persistd/config.json"
        );
        assert_eq!(
            paths.changed_dir.to_string_lossy(),
            "/data/persistd/changed"
        );
        assert_eq!(
            paths.removed_dir.to_string_lossy(),
            "/data/persistd/removed"
        );
        assert_eq!(
            paths.metadata_file.to_string_lossy(),
            "/data/persistd/metadata.jsonl"
        );
        assert_eq!(
            paths.state_db.to_string_lossy(),
            "/data/persistd/.internal/state.sqlite"
        );
        assert_eq!(
            paths.lock_file.to_string_lossy(),
            "/data/persistd/.internal/lock"
        );
        assert_eq!(
            paths.control_socket.to_string_lossy(),
            "/data/persistd/.internal/control.sock"
        );
    }
}
