use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::{internal::StateDb, metadata, paths::Paths};

#[cfg(unix)]
use crate::{baseline::BaselineDb, public};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub metadata_records: usize,
    pub rebuilt_public_index: bool,
    pub baseline_present: bool,
    pub baseline_valid: bool,
    pub changed_entries: usize,
    pub removed_markers: usize,
    pub findings: Vec<String>,
}

pub fn run(paths: &Paths, db: &StateDb) -> Result<DoctorReport> {
    let metadata_records = metadata::compact(&paths.metadata_file)?;
    db.rebuild_public_index(paths)?;

    let mut findings = Vec::new();
    let baseline_present = paths.baseline_db.exists();
    if !baseline_present {
        findings.push(format!("missing baseline: {}", paths.baseline_db.display()));
    }

    #[cfg(unix)]
    {
        let baseline_valid = baseline_present && BaselineDb::open(&paths.baseline_db).is_ok();
        if baseline_present && !baseline_valid {
            findings.push(format!("invalid baseline: {}", paths.baseline_db.display()));
        }

        let changed_paths = public::list_public_paths(&paths.changed_dir)?;
        let removed_paths = public::list_public_file_paths(&paths.removed_dir)?;
        let changed_keys = changed_paths
            .iter()
            .map(|path| path.as_bytes().to_vec())
            .collect::<std::collections::BTreeSet<_>>();

        for removed in &removed_paths {
            if changed_keys.contains(removed.as_bytes()) {
                findings.push(format!("changed/removed conflict: {removed}"));
            }
        }

        if baseline_valid {
            let baseline = BaselineDb::open(&paths.baseline_db)?;
            for record in &metadata_records {
                let public_path = record.public_path()?;
                let changed_exists = public_path.destination(&paths.changed_dir).exists();
                let baseline_exists = baseline.get(&public_path)?.is_some();
                let fallback_only = matches!(
                    record.kind.as_str(),
                    "fifo" | "char_device" | "block_device"
                );
                if !changed_exists && !baseline_exists && !fallback_only {
                    findings.push(format!("stale metadata: {public_path}"));
                }
            }
        }

        Ok(DoctorReport {
            metadata_records: metadata_records.len(),
            rebuilt_public_index: true,
            baseline_present,
            baseline_valid,
            changed_entries: changed_paths.len(),
            removed_markers: removed_paths.len(),
            findings,
        })
    }

    #[cfg(not(unix))]
    {
        Ok(DoctorReport {
            metadata_records: metadata_records.len(),
            rebuilt_public_index: true,
            baseline_present,
            baseline_valid: baseline_present,
            changed_entries: 0,
            removed_markers: 0,
            findings,
        })
    }
}

pub fn print_human(report: &DoctorReport) {
    println!("persistd doctor:");
    println!("  metadataRecords: {}", report.metadata_records);
    println!("  rebuiltPublicIndex: {}", report.rebuilt_public_index);
    println!("  baselinePresent: {}", report.baseline_present);
    println!("  baselineValid: {}", report.baseline_valid);
    println!("  changedEntries: {}", report.changed_entries);
    println!("  removedMarkers: {}", report.removed_markers);
    if report.findings.is_empty() {
        println!("  findings: none");
    } else {
        for finding in &report.findings {
            println!("  finding: {finding}");
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::run;
    use crate::{
        baseline::{GenerateOptions, generate},
        internal::StateDb,
        layout,
        metadata::{self, MetadataRecord},
        paths::Paths,
        public::PublicPath,
    };
    use std::fs;

    #[test]
    fn doctor_reports_conflicts_and_stale_metadata_without_pruning() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let paths = Paths::new(
            root.join("opt/persistd"),
            temp.path().join("run/persistd"),
            temp.path().join("data/persistd"),
        );
        fs::create_dir_all(root.join("opt/persistd")).unwrap();
        generate(&GenerateOptions {
            root,
            output: paths.baseline_db.clone(),
        })
        .unwrap();
        layout::ensure(&paths).unwrap();
        fs::write(paths.changed_dir.join("conflict"), "changed").unwrap();
        fs::write(paths.removed_dir.join("conflict"), "").unwrap();

        let public_path = PublicPath::parse("/stale").unwrap();
        let mut record = MetadataRecord {
            version: 1,
            path: String::new(),
            path_bytes_b64: None,
            kind: "file".into(),
            mode: None,
            uid: None,
            gid: None,
            mtime_ns: None,
            symlink_target: None,
            symlink_target_bytes_b64: None,
            rdev_major: None,
            rdev_minor: None,
            hardlink_key: None,
            xattrs: None,
            acl: None,
            capability: None,
        };
        record.set_public_path(&public_path);
        metadata::upsert(&paths.metadata_file, record).unwrap();

        let db = StateDb::open_or_rebuild(&paths).unwrap();
        let report = run(&paths, &db).unwrap();

        assert!(report.baseline_valid);
        assert_eq!(report.changed_entries, 1);
        assert_eq!(report.removed_markers, 1);
        assert!(
            report
                .findings
                .iter()
                .any(|finding| finding.contains("changed/removed conflict"))
        );
        assert!(
            report
                .findings
                .iter()
                .any(|finding| finding.contains("stale metadata"))
        );
        assert!(paths.changed_dir.join("conflict").exists());
        assert!(paths.removed_dir.join("conflict").exists());
    }
}
