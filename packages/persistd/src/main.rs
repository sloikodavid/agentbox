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

    persistd::cli::run(persistd::cli::Args::parse())
}
