//! Vantyr server: Axum HTTP API, static dashboard, `WebSockets` for agents and viewers, `PostgreSQL`.
//!
//! Configuration is via environment variables; see `.env.example` in the repository root and the wiki (Configuration + Environment template).

mod agent_ws;
mod agents;
mod app;
mod auth;
mod config;
mod control;
mod db;
mod error;
mod http;
mod integration;
mod notify;
mod platform;
mod policy;
mod recall;
mod scripts;
mod state;
#[cfg(test)]
mod test_support;
mod viewer;
mod web_activity;

use std::io::{stderr, IsTerminal};
use std::net::SocketAddr;
use std::sync::Arc;

use config::{LogConfig, ServerConfig};
use tracing::info;
use tracing_subscriber::{fmt, EnvFilter};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let log_cfg = LogConfig::from_env();
    if log_cfg.json {
        fmt()
            .json()
            .with_env_filter(
                EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
            )
            .with_target(false)
            .init();
    } else {
        let ansi = !log_cfg.no_color && (stderr().is_terminal() || log_cfg.force_color);
        fmt()
            .with_env_filter(
                EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
            )
            .with_target(false)
            .compact()
            .with_ansi(ansi)
            .init();
    }

    let cfg = ServerConfig::from_env()?;
    error::set_expose_internal_errors(cfg.expose_internal_errors);

    let pool = db::connect_and_migrate(&cfg).await?;

    let allow_insecure_dashboard_open = auth::users::bootstrap_dashboard_users(&pool, &cfg).await?;

    if allow_insecure_dashboard_open {
        info!("Dashboard can run without users (insecure opt-in).");
    }

    info!("Agent WebSocket auth: per-device bearer tokens only.");

    if let Some(oidc_cfg) = &cfg.oidc {
        if oidc_cfg.allowed_groups.is_empty() {
            tracing::warn!(
                "OIDC is configured with open provisioning: any successful IdP login creates a \
                 dashboard user. Set OIDC_ALLOWED_GROUPS to restrict who can be provisioned."
            );
        }
    }

    if !cfg.wol_min_interval.is_zero() {
        info!(
            "Wake-on-LAN per-agent throttle: {}s.",
            cfg.wol_min_interval.as_secs()
        );
    }

    if cfg.allow_remote_script {
        info!("Remote script execution from the dashboard is ENABLED (ALLOW_REMOTE_SCRIPT_EXECUTION).");
    }

    info!(
        "Scheduler timezone: {} (set SCHEDULER_TIMEZONE to change, e.g. Asia/Kuala_Lumpur)",
        cfg.scheduler_tz
    );

    let prom_metrics = if cfg.metrics_enabled {
        Some(platform::metrics::AppMetrics::new()?)
    } else {
        None
    };
    if cfg.metrics_enabled {
        info!("Prometheus metrics enabled at /metrics");
    }

    let notify_hub = notify::NotifyHub::from_env(&pool, cfg.vapid.as_ref());
    if !notify_hub.is_empty() {
        info!(
            providers = ?notify_hub.provider_ids(),
            "External notification providers enabled"
        );
    }
    let vapid_public_key = cfg.vapid.as_ref().map(|v| v.public_key.clone());

    if cfg.integration_api_token.is_some() {
        info!("Integration API enabled at GET /api/integration/agents/live (Bearer INTEGRATION_API_TOKEN).");
    }

    if let Some(ref base) = cfg.public_base_url {
        info!(public_base_url = %base, "Public base URL configured for external deep links");
    }

    // Screen-history blob store: ensure the directory exists up front so ingest
    // never has to create the root under lock. Sub-dirs (per agent/day) are made lazily.
    let screen_history_dir = cfg.screen_history_dir.clone();
    if let Err(e) = std::fs::create_dir_all(&screen_history_dir) {
        tracing::warn!(
            error = %e,
            dir = %screen_history_dir.display(),
            "Could not create SCREEN_HISTORY_DIR; screen-history ingest may fail until it exists"
        );
    } else {
        info!(dir = %screen_history_dir.display(), "Screen-history blob store");
    }

    let trusted_proxies = Arc::new(cfg.trusted_proxies.clone());
    if trusted_proxies.is_empty() {
        info!(
            "TRUSTED_PROXY_CIDRS not set: forwarding headers are ignored for rate limiting; \
             keying on the direct TCP peer. Set it if running behind a reverse proxy."
        );
    }

    let settings = state::Settings {
        allow_insecure_dashboard_open,
        wol_min_interval: cfg.wol_min_interval,
        allow_remote_script: cfg.allow_remote_script,
        integration_api_token: cfg.integration_api_token.clone(),
        public_base_url: cfg.public_base_url.clone(),
        scheduler_tz: cfg.scheduler_tz,
        trusted_proxies: trusted_proxies.clone(),
        screen_history_dir: screen_history_dir.clone(),
        vapid_public_key,
        cookie_secure: cfg.cookie_secure,
        oidc: cfg.oidc.clone(),
        mdns: cfg.mdns.clone(),
    };
    let state = Arc::new(state::AppState::new(
        pool,
        settings,
        prom_metrics.clone(),
        notify_hub,
    ));

    platform::retention::spawn_prune_task(
        state.clone(),
        cfg.retention_interval_secs,
        cfg.alert_event_retention_days,
        cfg.software_inventory_retention_days,
        cfg.script_execution_retention_days,
        cfg.metrics_retention_days,
        cfg.screen_history_retention_days,
    );

    // URL categorization (UT1 lists): background importer + categorization worker (disabled by default).
    web_activity::url_categorization::spawn(state.clone());

    scripts::scheduler::spawn(state.clone());
    control::runtime::spawn_expiry(state.clone());

    // Screen-history day-narrative worker (rule-based).
    recall::narrative::spawn(state.clone());

    // Periodic agent-offline alert evaluation (no-op unless offline rules exist).
    {
        let st = state.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                policy::alert_rules::evaluate_offline_alerts(&st).await;
            }
        });
    }

    platform::mdns::spawn_vantyr_mdns_if_enabled(&cfg.mdns);

    if let Some(ref m) = prom_metrics {
        let st = state.clone();
        let m = m.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
            loop {
                interval.tick().await;
                m.db_pool_size.set(i64::from(st.db.size()));
                m.db_pool_idle.set(st.db.num_idle() as i64);
                m.agents_online
                    .set(st.agents.connections.lock().len() as i64);
                let viewers: u64 = st
                    .media
                    .capture_viewers
                    .lock()
                    .values()
                    .map(|&c| u64::from(c))
                    .sum();
                m.ws_viewers_total.set(viewers as i64);
            }
        });
    }

    let app = app::router(state, &cfg)?;

    let addr = cfg.listen;
    info!("Listening on http://{addr}");

    let listener = tokio::net::TcpListener::bind(addr).await?;

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::warn!("Failed to install Ctrl+C handler: {e}");
        }
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    info!("shutdown signal received, draining connections");
}
