#![cfg(unix)]

use anyhow::Result;
use clap::Parser;
use std::path::PathBuf;

use persistd::baseline::{GenerateOptions, generate};

#[derive(Debug, Parser)]
#[command(
    name = "persistd-baseline",
    about = "Generate the Agentbox image baseline database"
)]
struct Args {
    #[arg(long, default_value = "/")]
    root: PathBuf,
    #[arg(long, default_value = "/opt/persistd/baseline.sqlite")]
    output: PathBuf,
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "persistd=info".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let args = Args::parse();
    generate(&GenerateOptions {
        root: args.root,
        output: args.output,
    })
}
