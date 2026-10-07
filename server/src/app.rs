//! HTTP router assembly: routes, rate limits, and the middleware stack.

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
use tower_governor::governor::GovernorConfigBuilder;
use tower_governor::GovernorLayer;
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::trace::TraceLayer;
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
};
use tracing::info;

use crate::config::ServerConfig;
use crate::state::AppState;
use crate::{
    agent_enroll_http, api, auth, integration, metrics, trusted_proxy, ws_agent, ws_terminal,
    ws_viewer,
};

/// Build the full application router. `cfg` supplies the HTTP-only knobs (static
/// dir, rate limit, CORS, HTTPS enforcement); everything else comes from `state`.
pub fn router(state: Arc<AppState>, cfg: &ServerConfig) -> anyhow::Result<Router> {
    let static_dir = cfg.static_dir.clone();

    let health_routes = Router::new()
        .route("/healthz", get(|| async { (StatusCode::OK, "ok") }))
        .route("/readyz", get(readiness))
        .with_state(state.clone());

    let metrics_routes = if state.metrics.is_some() {
        Router::new()
            .route(
                "/metrics",
                get(|State(s): State<Arc<AppState>>| async move {
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

    let ip_key_extractor =
        trusted_proxy::TrustedIpKeyExtractor(state.settings.trusted_proxies.clone());

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
                    .key_extractor(ip_key_extractor.clone())
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
                .key_extractor(ip_key_extractor.clone())
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
        .layer(cors_layer(cfg.cors_origins.clone()))
        .layer(from_fn_with_state(cfg.enforce_https, require_https))
        .with_state(state);

    Ok(app)
}

async fn readiness(State(s): State<Arc<AppState>>) -> impl IntoResponse {
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
    State(state): State<Arc<AppState>>,
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

/// Credentialed CORS for the configured origins; no CORS headers when there are none.
fn cors_layer(origins: Vec<HeaderValue>) -> CorsLayer {
    if origins.is_empty() {
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
