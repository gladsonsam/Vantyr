//! Vantyr server: Axum HTTP API, static dashboard, `WebSockets` for agents and viewers, `PostgreSQL`.
//!
//! Configuration is via environment variables; see `.env.example` in the repository root and the wiki (Configuration + Environment template).

mod agent_enroll_http;
mod alert_rules;
mod api;
mod auth;
mod config;
mod db;
mod error;
mod integration;
mod mdns_broadcast;
mod metrics;
mod notify;
mod oidc;
mod oidc_http;
mod scheduler;
mod secrets;
mod state;
mod twofa;
mod url_categorization;
mod wol;
mod ws_agent;
mod ws_terminal;
mod ws_viewer;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::extract::Request;
use axum::extract::State;
use axum::http::header::{self, HeaderValue};
use axum::http::StatusCode;
use axum::http::{HeaderName, Method};
use axum::middleware::Next;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{
    middleware::{from_fn, from_fn_with_state},
    Router,
};
use std::io::{stderr, IsTerminal};
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::trace::TraceLayer;
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
};

use config::ServerConfig;
use tracing::info;
use tracing_subscriber::{fmt, EnvFilter};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cfg = ServerConfig::from_env()?;

    if cfg.log_json {
        fmt()
            .json()
            .with_env_filter(
                EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
            )
            .with_target(false)
            .init();
    } else {
        let ansi = std::env::var("NO_COLOR").is_err()
            && (stderr().is_terminal()
                || std::env::var("LOG_FORCE_COLOR")
                    .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
                    .unwrap_or(false));
        fmt()
            .with_env_filter(
                EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
            )
            .with_target(false)
            .compact()
            .with_ansi(ansi)
            .init();
    }

    let pool = setup_database_and_migrations(&cfg).await?;

    let allow_insecure_dashboard_open = bootstrap_dashboard_users(&pool).await?;

    spawn_retention_prune_task(
        pool.clone(),
        cfg.retention_interval_secs,
        cfg.alert_event_retention_days,
        cfg.software_inventory_retention_days,
        cfg.script_execution_retention_days,
        cfg.metrics_retention_days,
    );

    if allow_insecure_dashboard_open {
        info!("Dashboard can run without users (insecure opt-in).");
    }

    info!("Agent WebSocket auth: per-device bearer tokens only.");

    let wol_min_interval_secs: u64 = std::env::var("WOL_MIN_INTERVAL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(15);
    let wol_min_interval = std::time::Duration::from_secs(wol_min_interval_secs);
    if !wol_min_interval.is_zero() {
        info!(
            "Wake-on-LAN per-agent throttle: {}s.",
            wol_min_interval_secs
        );
    }

    let allow_remote_script =
        read_env_or_file("ALLOW_REMOTE_SCRIPT_EXECUTION").is_some_and(|v| parse_bool(&v));
    if allow_remote_script {
        info!("Remote script execution from the dashboard is ENABLED (ALLOW_REMOTE_SCRIPT_EXECUTION).");
    }

    let scheduler_tz: chrono_tz::Tz = read_env_or_file("SCHEDULER_TIMEZONE")
        .and_then(|s| s.trim().parse::<chrono_tz::Tz>().ok())
        .unwrap_or(chrono_tz::UTC);
    info!(
        "Scheduler timezone: {} (set SCHEDULER_TIMEZONE to change, e.g. Asia/Kuala_Lumpur)",
        scheduler_tz
    );

    let prom_metrics = if cfg.metrics_enabled {
        Some(metrics::AppMetrics::new()?)
    } else {
        None
    };
    if cfg.metrics_enabled {
        info!("Prometheus metrics enabled at /metrics");
    }

    let notify_hub = notify::NotifyHub::from_env();
    if !notify_hub.is_empty() {
        info!(
            providers = ?notify_hub.provider_ids(),
            "External notification providers enabled"
        );
    }

    let integration_api_token = read_env_or_file("INTEGRATION_API_TOKEN")
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string());
    if integration_api_token.is_some() {
        info!("Integration API enabled at GET /api/integration/agents/live (Bearer INTEGRATION_API_TOKEN).");
    }

    let public_base_url = read_env_or_file("PUBLIC_BASE_URL")
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty());
    if let Some(ref base) = public_base_url {
        info!(public_base_url = %base, "Public base URL configured for external deep links");
    }

    let state = Arc::new(state::AppState::new(state::AppStateParams {
        db: pool,
        allow_insecure_dashboard_open,
        wol_min_interval,
        allow_remote_script,
        metrics: prom_metrics.clone(),
        notify_hub,
        integration_api_token,
        public_base_url,
        agent_listen_port: cfg.listen.port(),
        scheduler_tz,
    }));

    // URL categorization (UT1 lists): background importer + categorization worker (disabled by default).
    url_categorization::spawn(state.clone());

    scheduler::spawn(state.clone());

    // Periodic agent-offline alert evaluation (no-op unless offline rules exist).
    {
        let st = state.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                alert_rules::evaluate_offline_alerts(&st).await;
            }
        });
    }

    mdns_broadcast::spawn_vantyr_mdns_if_enabled(cfg.listen.port());

    if let Some(ref m) = prom_metrics {
        let st = state.clone();
        let m = m.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
            loop {
                interval.tick().await;
                m.db_pool_size.set(i64::from(st.db.size()));
                m.db_pool_idle.set(st.db.num_idle() as i64);
                m.agents_online.set(st.agents.lock().len() as i64);
                let viewers: u64 = st
                    .capture_viewers
                    .lock()
                    .values()
                    .map(|&c| u64::from(c))
                    .sum();
                m.ws_viewers_total.set(viewers as i64);
            }
        });
    }

    let static_dir = cfg.static_dir.clone();

    let health_routes = Router::new()
        .route("/healthz", get(|| async { (StatusCode::OK, "ok") }))
        .route("/readyz", get(readiness))
        .with_state(state.clone());

    let metrics_routes = if prom_metrics.is_some() {
        Router::new()
            .route(
                "/metrics",
                get(|State(s): State<Arc<state::AppState>>| async move {
                    let Some(m) = s.metrics.clone() else {
                        return StatusCode::NOT_FOUND.into_response();
                    };
                    metrics::metrics_endpoint(m).into_response()
                }),
            )
            .with_state(state.clone())
    } else {
        Router::new()
    };

    let auth_routes = Router::new()
        .route("/api/login", post(auth::login))
        .route("/api/logout", post(auth::logout))
        .route("/api/auth/status", get(auth::status))
        .route("/api/auth/config", get(auth::config))
        .route("/api/auth/oidc/login", get(auth::oidc_login))
        .route("/api/auth/oidc/callback", get(auth::oidc_callback));

    let integration_routes = Router::new()
        .route(
            "/api/integration/agents/live",
            get(integration::agents_live),
        )
        .with_state(state.clone());

    use tower_governor::governor::GovernorConfigBuilder;
    use tower_governor::key_extractor::SmartIpKeyExtractor;
    use tower_governor::GovernorLayer;

    let enroll_routes = Router::new()
        .route(
            "/api/agent/enroll",
            post(agent_enroll_http::agent_enroll_handler),
        )
        .route(
            "/api/agent/enrollment/claims",
            post(agent_enroll_http::create_enrollment_claim),
        )
        .route(
            "/api/agent/enrollment/claims/:id",
            get(agent_enroll_http::poll_enrollment_claim),
        )
        .layer(GovernorLayer {
            config: std::sync::Arc::new(
                GovernorConfigBuilder::default()
                    // Short 6-digit codes: keep enroll attempts expensive to brute-force per IP.
                    .per_second(1)
                    .burst_size(8)
                    .key_extractor(SmartIpKeyExtractor)
                    .finish()
                    .ok_or_else(|| anyhow::anyhow!("Invalid governor config for enroll"))?,
            ),
        })
        .with_state(state.clone());

    let api_inner = if cfg.api_rate_limit_per_second > 0 {
        let n = cfg.api_rate_limit_per_second.clamp(1, 500);
        let burst_u = (n * 2).min(1000).max(n).min(u64::from(u32::MAX)) as u32;
        let governor_conf = std::sync::Arc::new(
            GovernorConfigBuilder::default()
                .per_second(n)
                .burst_size(burst_u)
                .key_extractor(SmartIpKeyExtractor)
                .finish()
                .ok_or_else(|| anyhow::anyhow!("Invalid governor config for API"))?,
        );
        info!("API rate limit: {} req/s (burst {})", n, burst_u);
        api::router().layer(GovernorLayer {
            config: governor_conf,
        })
    } else {
        api::router()
    };

    let protected = Router::new()
        .route("/ws/view", get(ws_viewer::handler))
        .route("/ws/terminal", get(ws_terminal::handler))
        .nest("/api", api_inner)
        .route_layer(from_fn_with_state(state.clone(), auth::require_auth));

    let index_path = format!("{static_dir}/index.html");

    let x_request_id = HeaderName::from_static("x-request-id");

    let app = Router::new()
        .route("/ws/agent", get(ws_agent::handler))
        .merge(health_routes)
        .merge(metrics_routes)
        .merge(auth_routes)
        .merge(integration_routes)
        .merge(enroll_routes)
        .merge(protected)
        // SPA fallback: any path that isn't an API/WS route or a real file under `static_dir`
        // serves `index.html`, so client-side routes (`/agents/:id`, `/logs`, `/rules`,
        // `/groups`, `/users`, …) deep-link correctly. `not_found_service` handles every client
        // route uniformly — there's no need to enumerate them here.
        .fallback_service(
            ServeDir::new(&static_dir)
                .append_index_html_on_directories(true)
                .not_found_service(ServeFile::new(index_path)),
        )
        .layer(from_fn(set_static_cache_headers))
        .layer(from_fn_with_state(state.clone(), record_http_metrics))
        .layer(
            TraceLayer::new_for_http().make_span_with(|req: &Request<Body>| {
                let rid = req
                    .headers()
                    .get("x-request-id")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("-");
                tracing::info_span!(
                    "request",
                    request_id = %rid,
                    method = %req.method(),
                    path = %req.uri().path()
                )
            }),
        )
        .layer(PropagateRequestIdLayer::new(x_request_id.clone()))
        .layer(SetRequestIdLayer::new(x_request_id, MakeRequestUuid))
        .layer(cors_layer_from_env())
        .layer(from_fn_with_state(https_enforced(), require_https))
        .with_state(state.clone());

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

async fn setup_database_and_migrations(cfg: &ServerConfig) -> anyhow::Result<sqlx::PgPool> {
    let db_url = cfg.database_url.clone();

    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(cfg.pool_max_connections)
        .connect(&db_url)
        .await
        .map_err(|e| anyhow::anyhow!("Database connection failed: {e}"))?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .map_err(|e| match e {
            sqlx::migrate::MigrateError::VersionMismatch(v) => anyhow::anyhow!(
                "Migration {v} checksum mismatch: the SQL embedded in this binary does not match `_sqlx_migrations` (common after editing an already-applied migration, or CRLF vs LF drift).\n\
                 \n\
                 Fix: rebuild the server from the repo, then sync checksums from the **same** `server/migrations` files used for that build:\n\
 cargo run --locked -p vantyr-server --bin migration_checksums\n\
                 Apply the printed UPDATEs with `psql` against this database, then restart.\n\
                 Inspect: SELECT version, encode(checksum,'hex') AS checksum_hex FROM _sqlx_migrations WHERE version = {v};\n\
                 \n\
                 (Docker builds now normalize `*.sql` to LF before compile.)\n\
                 \n\
                 Underlying error: {e}"
            ),
            sqlx::migrate::MigrateError::Dirty(v) => anyhow::anyhow!(
                "Migration {v} is dirty (partial apply). Check `_sqlx_migrations` for success = false. Resolve the failed migration SQL manually, then delete or fix that row before restarting.\n\
                 Underlying error: {e}"
            ),
            _ => anyhow::anyhow!("Migration failed: {e}"),
        })?;

    info!("Database ready.");
    Ok(pool)
}

async fn bootstrap_dashboard_users(pool: &sqlx::PgPool) -> anyhow::Result<bool> {
    let allow_insecure_dashboard_open_env =
        read_env_or_file("ALLOW_INSECURE_DASHBOARD_OPEN").is_some_and(|v| parse_bool(&v));
    let allow_insecure_dashboard_open = if cfg!(debug_assertions) {
        allow_insecure_dashboard_open_env
    } else {
        if allow_insecure_dashboard_open_env {
            tracing::warn!("Ignoring ALLOW_INSECURE_DASHBOARD_OPEN in release builds (insecure).");
        }
        false
    };

    let admin_username = read_env_or_file("ADMIN_USERNAME")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "admin".to_string());

    let admin_password = read_env_or_file("ADMIN_PASSWORD")
        .or_else(|| read_env_or_file("UI_PASSWORD"))
        .filter(|s| !s.is_empty());

    let users = db::dashboard_user_count(pool).await.unwrap_or(0);
    if users == 0 {
        match admin_password {
            Some(ref pw) => {
                db::bootstrap_default_admin(pool, &admin_username, pw).await?;
                info!("Bootstrapped default dashboard user '{admin_username}' (role: admin).");
            }
            None => {
                if allow_insecure_dashboard_open {
                    info!("No dashboard users exist yet; dashboard is open (ALLOW_INSECURE_DASHBOARD_OPEN=true).");
                } else {
                    return Err(anyhow::anyhow!(
                        "No dashboard users exist. Set ADMIN_PASSWORD (or UI_PASSWORD) to bootstrap the default admin."
                    ));
                }
            }
        }
    }

    if allow_insecure_dashboard_open {
        info!("Dashboard can run without users (insecure opt-in).");
    }

    Ok(allow_insecure_dashboard_open)
}

fn spawn_retention_prune_task(
    pool_retention: sqlx::PgPool,
    ret_secs: u64,
    alert_days: Option<i64>,
    software_days: Option<i64>,
    script_exec_days: Option<i64>,
    metrics_days: Option<i64>,
) {
    tokio::spawn(async move {
        if let Err(e) = db::prune_telemetry_by_retention(&pool_retention).await {
            tracing::warn!(error = %e, "initial retention prune failed");
        }
        if let Err(e) = db::prune_auxiliary_retention(
            &pool_retention,
            alert_days,
            software_days,
            script_exec_days,
            metrics_days,
        )
        .await
        {
            tracing::warn!(error = %e, "initial auxiliary retention prune failed");
        }
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(ret_secs));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if let Err(e) = db::prune_telemetry_by_retention(&pool_retention).await {
                tracing::warn!(error = %e, "retention prune failed");
            }
            if let Err(e) = db::prune_auxiliary_retention(
                &pool_retention,
                alert_days,
                software_days,
                script_exec_days,
                metrics_days,
            )
            .await
            {
                tracing::warn!(error = %e, "auxiliary retention prune failed");
            }
        }
    });
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

async fn readiness(State(s): State<Arc<state::AppState>>) -> impl IntoResponse {
    match sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(&s.db)
        .await
    {
        Ok(_) => (StatusCode::OK, "ready"),
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, "not ready"),
    }
}

/// Cache policy for the built dashboard:
/// - content-hashed bundles under `/assets/` never change, so they're cached forever (`immutable`);
/// - `index.html` (served directly and via the SPA fallback) must always revalidate — otherwise a
///   browser can keep an old `index.html` that points at bundle hashes the next deploy removed,
///   producing a blank page.
///
/// API/WS responses and handlers that set their own `Cache-Control` (app icons, screenshots) are
/// left untouched. A missing `/assets/*` file falls through to `index.html` (text/html); we detect
/// that and treat it as the HTML case rather than marking it immutable.
async fn set_static_cache_headers(req: Request<Body>, next: Next) -> Response {
    let is_asset_path = req.uri().path().starts_with("/assets/");
    let mut res = next.run(req).await;

    let is_html = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/html"));

    let headers = res.headers_mut();
    if is_asset_path && !is_html {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    } else if is_html && !headers.contains_key(header::CACHE_CONTROL) {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    }

    res
}

async fn record_http_metrics(
    State(state): State<Arc<state::AppState>>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let method = req.method().clone();
    let start = Instant::now();
    let res = next.run(req).await;
    if let Some(ref m) = state.metrics {
        let status = res.status().as_u16().to_string();
        let elapsed = start.elapsed().as_secs_f64();
        m.http_duration_seconds
            .with_label_values(&[method.as_str()])
            .observe(elapsed);
        m.http_requests
            .with_label_values(&[method.as_str(), &status])
            .inc();
    }
    res
}

fn https_enforced() -> bool {
    std::env::var("ENFORCE_HTTPS")
        .ok()
        .is_none_or(|v| parse_bool(&v))
}

async fn require_https(State(enforce): State<bool>, req: Request, next: Next) -> Response {
    if !enforce {
        return next.run(req).await;
    }

    let path = req.uri().path();
    if matches!(path, "/healthz" | "/readyz" | "/metrics") {
        return next.run(req).await;
    }

    let forwarded_proto = req
        .headers()
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if forwarded_proto.eq_ignore_ascii_case("https") || forwarded_proto.eq_ignore_ascii_case("wss")
    {
        next.run(req).await
    } else {
        (
            StatusCode::UPGRADE_REQUIRED,
            "HTTPS required (set ENFORCE_HTTPS=false for local HTTP testing).",
        )
            .into_response()
    }
}

fn cors_layer_from_env() -> CorsLayer {
    let raw = std::env::var("CORS_ORIGINS").unwrap_or_default();
    let raw = raw.trim();
    if raw.is_empty() {
        // Default: do not emit CORS headers. Browser cross-origin requests will be blocked.
        // Production deployments should set CORS_ORIGINS explicitly.
        return CorsLayer::new();
    }

    let origins: Vec<HeaderValue> = raw
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse::<HeaderValue>().ok())
        .collect();

    if origins.is_empty() {
        tracing::warn!("CORS_ORIGINS was set but no valid origins were parsed; CORS is disabled.");
        return CorsLayer::new();
    }

    CorsLayer::new()
        .allow_origin(origins)
        .allow_credentials(true)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            HeaderName::from_static("x-csrf-token"),
        ])
}

fn read_env_or_file(name: &str) -> Option<String> {
    if let Ok(val) = std::env::var(name) {
        return Some(val);
    }
    let file_key = format!("{name}_FILE");
    let path = std::env::var(file_key).ok()?;
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
}

fn parse_bool(s: &str) -> bool {
    matches!(
        s.trim(),
        "1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON"
    )
}
