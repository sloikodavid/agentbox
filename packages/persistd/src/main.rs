mod baseline;
mod cli;
mod config;
mod daemon;
mod internal;
mod layout;
mod metadata;
mod paths;
mod readiness;
mod update;

#[cfg(unix)]
mod apply;
#[cfg(unix)]
mod audit;
#[cfg(unix)]
mod watch;

use anyhow::Result;
use clap::Parser;

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "persistd=info".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    cli::run(cli::Args::parse())
}
