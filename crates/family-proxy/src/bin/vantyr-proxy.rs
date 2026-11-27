//! Vantyr Proxy command-line entry point.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use anyhow::{anyhow, bail, Result};
use family_proxy::server_authority::{
    HttpEvidenceVerifier, RemoteCredentialStore, DEFAULT_SYNC_TTL_SECS,
};
use family_proxy::{Config, ProxyServer};
use uuid::Uuid;

const USAGE: &str = "\
Vantyr Proxy — bounded HTTP/CONNECT forward proxy for Vantyr Network

Usage:
  vantyr-proxy --config <FILE>      validate FILE, then serve until Ctrl-C
  vantyr-proxy --check-config FILE  validate FILE without binding a listener
  vantyr-proxy --server-auth        opt in to server-backed credentials/evidence
  vantyr-proxy --help               show this help
  vantyr-proxy --version            show the version

The default listener is an unprivileged high loopback port. Credentials come
from a private (mode 0600) config file. Optional TLS inspection is off by
default and requires explicit client scope, a unique CA and client trust.
Opaque CONNECT keeps client-validated TLS. HTTP/2 and WebSocket are unsupported.
No host resolver, DHCP, firewall, router or CA setting is changed.

--server-auth is opt-in and reads:
  VANTYR_PROXY_INTROSPECTION_URL   https base URL of the server authority
  VANTYR_PROXY_WORKER_TOKEN        gateway Bearer with introspect_proxy scope
  VANTYR_PROXY_GATEWAY_ID          gateway uuid this worker is bound to
  VANTYR_PROXY_SYNC_TTL_SECS       optional, 1..=60 (default 5)
A stale authoritative cache fails closed; no bootstrap fallback is used.
";

fn env_required(name: &str) -> Result<String> {
    std::env::var(name).map_err(|_| anyhow!("{name} is required with --server-auth\n{USAGE}"))
}

async fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{USAGE}");
        return Ok(());
    }
    if args.iter().any(|arg| arg == "--version") {
        println!("Vantyr Proxy {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    let mut check_only = false;
    let mut server_auth = false;
    let mut path: Option<PathBuf> = None;
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--check-config" => check_only = true,
            "--server-auth" => server_auth = true,
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

    // All validation, including config permissions, completes before any
    // socket is bound.
    let config = Config::load(&path)?;
    if check_only {
        println!(
            "Vantyr Proxy: configuration valid (policy revision {}, {} client(s), {} destination(s))",
            config.policy_revision,
            config.clients.len(),
            config.destinations.len()
        );
        return Ok(());
    }

    if !server_auth {
        let server = ProxyServer::start(config).await?;
        eprintln!("Vantyr Proxy: listening on http {}", server.bind_addr());
        tokio::signal::ctrl_c().await?;
        eprintln!("Vantyr Proxy: shutting down");
        server.stop().await;
        return Ok(());
    }

    // Explicit opt-in only. Secrets come from the environment, never argv.
    let base_url = env_required("VANTYR_PROXY_INTROSPECTION_URL")?;
    if !base_url.starts_with("https://")
        && std::env::var("VANTYR_PROXY_ALLOW_INSECURE_HTTP").as_deref() != Ok("1")
    {
        bail!("--server-auth requires an https:// introspection URL");
    }
    let bearer = env_required("VANTYR_PROXY_WORKER_TOKEN")?;
    let gateway_id = Uuid::parse_str(&env_required("VANTYR_PROXY_GATEWAY_ID")?)?;
    let household_id = Uuid::parse_str(&config.household_id)?;
    let ttl_secs = match std::env::var("VANTYR_PROXY_SYNC_TTL_SECS") {
        Ok(value) => value.parse::<u64>()?,
        Err(_) => DEFAULT_SYNC_TTL_SECS,
    };

    let authority = RemoteCredentialStore::new(
        base_url.trim_end_matches('/'),
        bearer,
        household_id,
        gateway_id,
        ttl_secs,
    )?;
    authority.sync()?;
    let assignments = authority.assignments();
    let verifier = HttpEvidenceVerifier::new(
        base_url.trim_end_matches('/'),
        std::env::var("VANTYR_PROXY_WORKER_TOKEN")?,
        household_id,
        gateway_id,
        authority.fresh_gate(),
    )?;
    // Periodic authoritative refresh. A failed sync leaves the previous cache
    // in place; the shared freshness gate denies requests once it goes stale.
    let refresher = authority.clone();
    let period = authority.ttl();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(period).await;
            let authority = Arc::new(refresher.clone());
            if let Err(error) = tokio::task::spawn_blocking(move || authority.sync()).await {
                eprintln!("Vantyr Proxy: sync task failed: {error}");
            }
        }
    });

    let resolver = rama::dns::client::HickoryDnsResolver::try_new_system()
        .map_err(|error| anyhow!("resolver init failed: {error}"))?;
    let server = ProxyServer::start_with_session_auth(
        config,
        resolver,
        authority.credential_store(),
        Arc::new(verifier),
        (*assignments).clone(),
    )
    .await?;
    eprintln!(
        "Vantyr Proxy: listening on http {} (server-backed auth)",
        server.bind_addr()
    );
    tokio::signal::ctrl_c().await?;
    eprintln!("Vantyr Proxy: shutting down");
    server.stop().await;
    Ok(())
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Vantyr Proxy: {error:#}");
            ExitCode::FAILURE
        }
    }
}
