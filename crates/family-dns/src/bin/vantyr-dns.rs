//! Vantyr DNS command-line entry point.

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{anyhow, bail, Result};
use family_dns::{Config, DnsServer};

const USAGE: &str = "\
Vantyr DNS — policy-connected filtering resolver

Usage:
  vantyr-dns --config <FILE>      load FILE, validate it, then serve until Ctrl-C
  vantyr-dns --check-config FILE  validate FILE without binding a listener
  vantyr-dns --help               show this help
  vantyr-dns --version            show the version

The default listener is a high loopback port shared by UDP and TCP. No host
resolver, DHCP, firewall or router setting is changed.";

async fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{USAGE}");
        return Ok(());
    }
    if args.iter().any(|arg| arg == "--version") {
        println!("Vantyr DNS {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    let mut check_only = false;
    let mut path: Option<PathBuf> = None;
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--check-config" => check_only = true,
            "--config" => {
                let value = iter
                    .next()
                    .ok_or_else(|| anyhow!("--config needs a file path\n{USAGE}"))?;
                path = Some(PathBuf::from(value));
            }
            other if other.starts_with('-') => bail!("unknown option '{other}'\n{USAGE}"),
            other => {
                if path.is_some() {
                    bail!("configuration file supplied more than once\n{USAGE}");
                }
                path = Some(PathBuf::from(other));
            }
        }
    }
    let path = path.ok_or_else(|| anyhow!("a configuration file is required\n{USAGE}"))?;

    // Validation completes here, before DnsServer::start binds a socket.
    let config = Config::load(&path)?;
    if check_only {
        println!(
            "Vantyr DNS: configuration valid (policy revision {}, {} upstream(s), {} device(s))",
            config.policy_revision,
            config.upstreams.len(),
            config.devices.len()
        );
        return Ok(());
    }

    let server = DnsServer::start(config).await?;
    eprintln!("Vantyr DNS: listening on udp+tcp {}", server.bind_addr());
    tokio::signal::ctrl_c().await?;
    eprintln!("Vantyr DNS: shutting down");
    server.stop().await;
    eprintln!("Vantyr DNS: stopped");
    Ok(())
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Vantyr DNS: {error:#}");
            ExitCode::FAILURE
        }
    }
}
