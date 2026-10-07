//! Cross-cutting HTTP middleware: HTTPS enforcement, static-asset cache headers,
//! request metrics, and CORS.

use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{self, HeaderValue};
use axum::http::{HeaderName, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use tower_http::cors::CorsLayer;

use crate::state::AppState;

/// Cache policy for the built dashboard:
/// - content-hashed bundles under `/assets/` never change, so they're cached forever (`immutable`);
/// - `index.html` (served directly and via the SPA fallback) must always revalidate — otherwise a
///   browser can keep an old `index.html` that points at bundle hashes the next deploy removed,
///   producing a blank page.
///
/// API/WS responses and handlers that set their own `Cache-Control` (app icons, screenshots) are
/// left untouched. A missing `/assets/*` file falls through to `index.html` (text/html); we detect
/// that and treat it as the HTML case rather than marking it immutable.
pub async fn set_static_cache_headers(req: Request<Body>, next: Next) -> Response {
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

pub async fn record_http_metrics(
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

pub async fn require_https(State(enforce): State<bool>, req: Request, next: Next) -> Response {
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
pub fn cors_layer(origins: Vec<HeaderValue>) -> CorsLayer {
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
