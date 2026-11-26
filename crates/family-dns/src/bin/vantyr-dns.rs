//! Vantyr DNS command-line entry point.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use family_dns::{
    read_bounded, sync_once, BundleStore, BundleValidator, Config, ControllerClient,
    ControllerOptions, ControllerPoller, DnsServer, DurableOptions, ReloadOutcome,
    SubscriptionRuntime, SubscriptionSettings, SyncCapability, MAX_FILTER_BUNDLE_BYTES,
};

const USAGE: &str = "\
Vantyr DNS — policy-connected filtering resolver

Usage:
  vantyr-dns --config <FILE>                 validate FILE, then serve in memory
  vantyr-dns --config <FILE> --state <FILE> --worker <ID>
                                             opt in to one durable config+policy bundle
  vantyr-dns --state <FILE> --worker <ID> [--config <FILE>]
                                             restart from the local bundle (config only
                                             for first-run bootstrap and SIGHUP reload)
  vantyr-dns --check-config <FILE>           validate FILE without binding a listener
  vantyr-dns --state-status --state <FILE> --worker <ID>
                                             print local bundle metadata, no listener
  vantyr-dns --config <FILE> --state <FILE> --worker <ID> --controller <FILE>
                                             opt in to one HTTPS controller policy pull
                                             at startup (durable mode required)
  vantyr-dns ... --controller <FILE> --poll  also poll with bounded backoff
  vantyr-dns --config <FILE> --state <FILE> --worker <ID> --subscriptions <FILE>
                                             opt in to scheduled public-list refresh
                                             (durable mode required; no fetch without it)
  vantyr-dns --help                          show this help
  vantyr-dns --version                       show the version

--controller points to an owner-private (0600) options file containing the
HTTPS origin, credential FILE path and read-policy identities. The bearer secret
is never accepted as a command-line argument. Without --controller there is no
network control-plane contact; enrollment alone never configures this worker.
On Unix, SIGHUP re-reads --config (bounded to 64 KiB) and performs one atomic
reload; changes to the bind address or port require a full restart. No host
resolver, DHCP, firewall or router setting is changed.";

#[derive(Default)]
struct Args {
    config: Option<PathBuf>,
    state: Option<PathBuf>,
    worker: Option<String>,
    controller: Option<PathBuf>,
    subscriptions: Option<PathBuf>,
    poll: bool,
    check_only: bool,
    state_status: bool,
}

fn parse_args() -> Result<Args> {
    let mut args = Args::default();
    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                println!("{USAGE}");
                return Ok(Args::default());
            }
            "--version" => {
                println!("Vantyr DNS {}", env!("CARGO_PKG_VERSION"));
                return Ok(Args::default());
            }
            "--check-config" => args.check_only = true,
            "--state-status" => args.state_status = true,
            "--poll" => args.poll = true,
            "--config" | "--state" | "--worker" | "--controller" | "--subscriptions" => {
                let value = iter
                    .next()
                    .ok_or_else(|| anyhow!("{arg} needs a value\n{USAGE}"))?;
                match arg.as_str() {
                    "--config" => args.config = Some(PathBuf::from(value)),
                    "--state" => args.state = Some(PathBuf::from(value)),
                    "--controller" => args.controller = Some(PathBuf::from(value)),
                    "--subscriptions" => args.subscriptions = Some(PathBuf::from(value)),
                    _ => args.worker = Some(value),
                }
            }
            other if other.starts_with('-') => bail!("unknown option '{other}'\n{USAGE}"),
            other => {
                if args.config.is_some() {
                    bail!("configuration file supplied more than once\n{USAGE}");
                }
                args.config = Some(PathBuf::from(other));
            }
        }
    }
    Ok(args)
}

fn reload_from_file(server: &DnsServer, path: &std::path::Path) -> Result<ReloadOutcome> {
    let bytes = read_bounded(path)?;
    Ok(server.reload(&bytes, Utc::now())?)
}

fn show_help_requested() -> bool {
    std::env::args()
        .skip(1)
        .any(|a| a == "--help" || a == "-h" || a == "--version")
}

async fn run() -> Result<()> {
    if show_help_requested() {
        let _ = parse_args()?;
        return Ok(());
    }
    let args = parse_args()?;

    if args.state_status {
        let path = args
            .state
            .ok_or_else(|| anyhow!("--state-status needs --state\n{USAGE}"))?;
        let worker = args
            .worker
            .ok_or_else(|| anyhow!("--state-status needs --worker\n{USAGE}"))?;
        let store = BundleStore::open_from_snapshot_with_limit(
            &path,
            worker,
            BundleValidator,
            MAX_FILTER_BUNDLE_BYTES,
        )
        .map_err(|e| anyhow!("{e}"))?;
        let snapshot = store.snapshot().expect("loaded state has a snapshot");
        println!(
            "Vantyr DNS: schema {}, household {}, worker {}, bundle_generation {}, policy_revision {}, filter_generation {}, published_at {}, saved_at {}",
            snapshot.schema,
            snapshot.household_id,
            snapshot.worker_id,
            snapshot.highwater,
            snapshot.policy.revision(),
            snapshot.policy.filter_generation(),
            snapshot.policy.published_at().to_rfc3339(),
            snapshot.saved_at.to_rfc3339()
        );
        return Ok(());
    }

    if args.check_only {
        let path = args
            .config
            .ok_or_else(|| anyhow!("--check-config needs a file\n{USAGE}"))?;
        let config = Config::load(&path)?;
        println!(
            "Vantyr DNS: configuration valid (policy revision {}, {} upstream(s), {} device(s))",
            config.policy_revision,
            config.upstreams.len(),
            config.devices.len()
        );
        return Ok(());
    }

    if args.poll && args.controller.is_none() {
        bail!("--poll requires --controller\n{USAGE}");
    }
    if args.subscriptions.is_some()
        && (args.state.is_none() || args.worker.is_none() || args.config.is_none())
    {
        bail!("--subscriptions requires --state, --worker and --config (durable mode)\n{USAGE}");
    }
    if args.controller.is_some() {
        if args.state.is_none() || args.worker.is_none() {
            bail!("--controller requires --state and --worker (durable mode)\n{USAGE}");
        }
        if args.config.is_none() {
            bail!("--controller requires --config for transport and device mapping\n{USAGE}");
        }
    }

    // Controller options and the credential file are validated before a
    // listener exists. A misconfigured opt-in must fail closed at startup.
    let controller = match &args.controller {
        Some(path) => {
            let options = ControllerOptions::load(path)?;
            let client = Arc::new(ControllerClient::new(&options)?);
            Some((options, client))
        }
        None => None,
    };

    // Subscription settings are small and validated before any listener or
    // fetcher exists. With no opt-in there is no network list traffic at all.
    let subscription_runtime = match &args.subscriptions {
        Some(path) => {
            let settings: SubscriptionSettings = serde_json::from_slice(&read_bounded(path)?)?;
            settings.validate()?;
            let ca = match &settings.trusted_ca_pem {
                Some(path) => Some(read_bounded(Path::new(path))?),
                None => None,
            };
            Some(Arc::new(SubscriptionRuntime::new(
                &settings,
                ca.as_deref()
                    .map(|bytes| std::str::from_utf8(bytes))
                    .transpose()?,
            )?))
        }
        None => None,
    };

    // The subscription startup path returns the ONE canonical Arc: the
    // integrator task must observe the same allocation for its whole life.
    let server: Arc<DnsServer> = match (&args.state, &args.worker) {
        (Some(state), Some(worker)) => match subscription_runtime {
            Some(runtime) => {
                DnsServer::start_durable_with_subscriptions(
                    DurableOptions {
                        state_path: state.clone(),
                        worker_id: worker.clone(),
                        config_path: args.config.clone(),
                        now: Utc::now(),
                        hooks: None,
                    },
                    Some(runtime),
                )
                .await?
            }
            None => Arc::new(
                DnsServer::start_durable(DurableOptions {
                    state_path: state.clone(),
                    worker_id: worker.clone(),
                    config_path: args.config.clone(),
                    now: Utc::now(),
                    hooks: None,
                })
                .await?,
            ),
        },
        (None, None) => {
            let path = args
                .config
                .as_ref()
                .ok_or_else(|| anyhow!("a configuration file is required\n{USAGE}"))?;
            Arc::new(DnsServer::start(Config::load(path)?).await?)
        }
        _ => bail!("--state and --worker must be supplied together\n{USAGE}"),
    };
    eprintln!(
        "Vantyr DNS: listening on udp+tcp {} (durable: {})",
        server.bind_addr(),
        server.is_durable()
    );

    let mut poller = None;
    if let Some((options, client)) = &controller {
        // A first pull is part of the explicit opt-in. A controller outage or
        // rejection never discards the durable last-known-good bundle.
        match sync_once(&server, client, Utc::now()).await {
            Ok(SyncCapability::AppliedLocally { revision }) => {
                eprintln!("Vantyr DNS: controller policy applied locally at revision {revision}");
            }
            Ok(SyncCapability::Unchanged { revision }) => {
                eprintln!("Vantyr DNS: controller policy unchanged at revision {revision}");
            }
            Ok(SyncCapability::Unsupported(detail)) => {
                eprintln!("Vantyr DNS: controller policy unsupported: {detail}");
            }
            Err(error) => {
                // Error Display never contains a credential or response body.
                eprintln!("Vantyr DNS: initial controller pull failed: {error:#}");
            }
        }
        if args.poll {
            poller = Some(ControllerPoller::start(
                Arc::clone(&server),
                Arc::clone(client),
                options.clone(),
            ));
        }
    }

    #[cfg(unix)]
    {
        let mut hup = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())
            .context("cannot install SIGHUP handler")?;
        loop {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => break,
                _ = hup.recv() => {
                    match &args.config {
                        Some(path) => {
                            let outcome = reload_from_file(&server, path);
                            match outcome {
                                Ok(outcome) => eprintln!(
                                    "Vantyr DNS: reload applied revision {} (published_at {})",
                                    outcome.revision,
                                    outcome.published_at.to_rfc3339()
                                ),
                                Err(error) => eprintln!("Vantyr DNS: reload rejected: {error:#}"),
                            }
                        }
                        None => eprintln!("Vantyr DNS: SIGHUP ignored; no --config path to reload"),
                    }
                }
            }
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await?;

    if let Some(poller) = poller.take() {
        poller.stop().await;
    }
    eprintln!("Vantyr DNS: shutting down");
    // Join the integrator before consuming the listener; an in-flight download
    // may hold an upgraded Arc and must be cancelled and awaited first.
    server.stop_shared().await;
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
