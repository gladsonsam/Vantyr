//! HTTP router assembly: routes, rate limits, and the middleware stack.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::Request;
use axum::extract::State;
use axum::http::HeaderName;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{
    middleware::{from_fn, from_fn_with_state},
    Router,
};
use tower_governor::governor::GovernorConfigBuilder;
use tower_governor::GovernorLayer;
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing::info;

use crate::config::ServerConfig;
use crate::error::ApiError;
use crate::http::middleware;
use crate::http::trusted_proxy::TrustedIpKeyExtractor;
use crate::state::AppState;
use crate::{agent_enroll_http, api, auth, integration, metrics, ws_agent, ws_terminal, ws_viewer};

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

    let auth_routes = auth::public_routes();

    let integration_routes = Router::new()
        .route(
            "/api/integration/agents/live",
            get(integration::agents_live),
        )
        .with_state(state.clone());

    let ip_key_extractor = TrustedIpKeyExtractor(state.settings.trusted_proxies.clone());

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
        api_routes().layer(GovernorLayer {
            config: governor_conf,
        })
    } else {
        api_routes()
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
        .layer(from_fn(middleware::set_static_cache_headers))
        .layer(from_fn_with_state(
            state.clone(),
            middleware::record_http_metrics,
        ))
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
        .layer(middleware::cors_layer(cfg.cors_origins.clone()))
        .layer(from_fn_with_state(
            cfg.enforce_https,
            middleware::require_https,
        ))
        .with_state(state);

    Ok(app)
}

/// The authenticated dashboard API, nested under `/api`. Each feature contributes its routes.
pub(crate) fn api_routes() -> Router<Arc<AppState>> {
    Router::new()
        .merge(api::router())
        .merge(crate::agents::routes())
        .merge(auth::routes())
        .merge(crate::platform::routes())
        .merge(crate::policy::routes())
        .merge(crate::recall::routes())
        .merge(crate::scripts::routes())
        .merge(crate::web_activity::routes())
        .fallback(api_not_found)
}

/// Unknown `/api/*` paths return a JSON 404 instead of falling through to the SPA fallback
/// (which would serve `index.html` with a `200`, breaking the dashboard's JSON `fetch` clients).
async fn api_not_found() -> ApiError {
    ApiError::not_found("Unknown API endpoint")
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
