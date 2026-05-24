use anyhow::Result;
use serde::{Deserialize, Serialize};

#[cfg(unix)]
use std::{fs, path::Path};

#[cfg(unix)]
use crate::{
    baseline::BaselineDb,
    config::Config,
    internal::StateDb,
    metadata,
    paths::Paths,
    public,
    update::{self, UpdateContext, UpdateOutcome},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneReport {
    pub removed: Vec<String>,
    pub skipped: Vec<String>,
}

#[cfg(unix)]
pub fn run(
    root: &Path,
    paths: &Paths,
    config: &Config,
    baseline: &BaselineDb,
    db: &StateDb,
) -> Result<PruneReport> {
    let mut report = PruneReport {
        removed: Vec::new(),
        skipped: Vec::new(),
    };

    prune_baseline_equal_changed(root, paths, config, baseline, &mut report)?;
    prune_stale_tombstones(paths, config, baseline, &mut report)?;
    prune_stale_metadata(root, paths, config, baseline, &mut report)?;
    prune_empty_dirs(&paths.changed_dir, "changed", &mut report)?;
    prune_empty_dirs(&paths.removed_dir, "removed", &mut report)?;
    db.rebuild_public_index(paths)?;
    Ok(report)
}

#[cfg(not(unix))]
pub fn run(_paths: &crate::paths::Paths, _db: &crate::internal::StateDb) -> Result<PruneReport> {
    Ok(PruneReport {
        removed: Vec::new(),
        skipped: vec!["prune is only supported on Unix".into()],
    })
}

#[cfg(unix)]
fn prune_baseline_equal_changed(
    root: &Path,
    paths: &Paths,
    config: &Config,
    baseline: &BaselineDb,
    report: &mut PruneReport,
) -> Result<()> {
    let ctx = UpdateContext {
        root,
        paths,
        config,
        baseline,
    };

    for entry in public::list_public_entries(&paths.changed_dir)? {
        if public::is_excluded(&entry.path, config) {
            report.skipped.push(format!("excluded {}", entry.path));
            continue;
        }
        if matches!(
            update::update_public_path(&ctx, &entry.path)?,
            UpdateOutcome::Pruned
        ) {
            report
                .removed
                .push(format!("baseline-equal changed {}", entry.path));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn prune_stale_tombstones(
    paths: &Paths,
    config: &Config,
    baseline: &BaselineDb,
    report: &mut PruneReport,
) -> Result<()> {
    for public_path in public::list_public_file_paths(&paths.removed_dir)? {
        if public::is_excluded(&public_path, config) {
            report.skipped.push(format!("excluded {}", public_path));
            continue;
        }
        if baseline.get(&public_path)?.is_none()
            && !public_path.destination(&paths.changed_dir).exists()
        {
            public::remove_path(&public_path.destination(&paths.removed_dir))?;
            report
                .removed
                .push(format!("stale tombstone {}", public_path));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn prune_stale_metadata(
    root: &Path,
    paths: &Paths,
    config: &Config,
    baseline: &BaselineDb,
    report: &mut PruneReport,
) -> Result<()> {
    let mut kept = Vec::new();
    for record in metadata::load(&paths.metadata_file)? {
        let public_path = record.public_path()?;
        if public::is_excluded(&public_path, config) {
            kept.push(record);
            report.skipped.push(format!("excluded {}", public_path));
            continue;
        }
        let live_exists = public::live_path(root, &public_path).exists()
            || fs::symlink_metadata(public::live_path(root, &public_path)).is_ok();
        let changed_exists = public_path.destination(&paths.changed_dir).exists();
        let baseline_exists = baseline.get(&public_path)?.is_some();
        if !live_exists && !changed_exists && !baseline_exists {
            report
                .removed
                .push(format!("stale metadata {}", public_path));
        } else {
            kept.push(record);
        }
    }

    metadata::replace(&paths.metadata_file, &kept)?;
    Ok(())
}

#[cfg(unix)]
fn prune_empty_dirs(root: &Path, label: &str, report: &mut PruneReport) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }
    let mut dirs = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .min_depth(1)
        .contents_first(true)
    {
        let entry = entry?;
        if entry.file_type().is_dir() {
            dirs.push(entry.path().to_path_buf());
        }
    }
    for dir in dirs {
        if fs::read_dir(&dir)?.next().is_none() {
            let display = dir
                .strip_prefix(root)
                .ok()
                .and_then(|path| public::PublicPath::from_root_relative(path).ok())
                .map(|path| path.display())
                .unwrap_or_else(|| dir.display().to_string());
            fs::remove_dir(&dir)?;
            report.removed.push(format!("empty {label} dir {display}"));
        }
    }
    Ok(())
}

pub fn print_human(report: &PruneReport) {
    println!("persistd prune:");
    if report.removed.is_empty() {
        println!("  removed: none");
    } else {
        for removed in &report.removed {
            println!("  removed: {removed}");
        }
    }
    for skipped in &report.skipped {
        println!("  skipped: {skipped}");
    }
}

#[cfg(test)]
mod tests {
    use super::run;
    use crate::{
        baseline::{BaselineDb, GenerateOptions, generate},
        config::Config,
        internal::StateDb,
        layout,
        paths::Paths,
    };
    use std::fs;

    #[test]
    fn prune_removes_stale_tombstone_and_empty_dirs() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.paths.removed_dir.join("gone")).unwrap();
        fs::write(fixture.paths.removed_dir.join("gone/file"), "").unwrap();

        let report = run(
            &fixture.root,
            &fixture.paths,
            &Config::default(),
            &fixture.baseline,
            &fixture.db,
        )
        .unwrap();

        assert!(
            report
                .removed
                .iter()
                .any(|item| item.contains("stale tombstone"))
        );
        assert!(!fixture.paths.removed_dir.join("gone/file").exists());
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        root: std::path::PathBuf,
        paths: Paths,
        baseline: BaselineDb,
        db: StateDb,
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
            generate(&GenerateOptions {
                root: root.clone(),
                output: paths.baseline_db.clone(),
            })
            .unwrap();
            layout::ensure(&paths).unwrap();
            let baseline = BaselineDb::open(&paths.baseline_db).unwrap();
            let db = StateDb::open_or_rebuild(&paths).unwrap();
            Self {
                _temp: temp,
                root,
                paths,
                baseline,
                db,
            }
        }
    }
}
