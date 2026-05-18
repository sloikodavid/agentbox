use anyhow::{Context, Result};
use serde::Serialize;
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::paths::Paths;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadyFile<'a> {
    ready: bool,
    updated_at: String,
    phase: &'a str,
}

pub fn write_ready(paths: &Paths, phase: &str) -> Result<()> {
    fs::create_dir_all(&paths.run_dir)
        .with_context(|| format!("create {}", paths.run_dir.display()))?;

    let ready = ReadyFile {
        ready: true,
        updated_at: timestamp(),
        phase,
    };
    let mut data = serde_json::to_vec_pretty(&ready).context("encode ready file")?;
    data.push(b'\n');
    fs::write(&paths.ready_file, data)
        .with_context(|| format!("write {}", paths.ready_file.display()))
}

fn timestamp() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:09}Z", duration.as_secs(), duration.subsec_nanos())
}
