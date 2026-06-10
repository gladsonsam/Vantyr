//! Prometheus metrics (`GET /metrics`).

use std::sync::Arc;

use axum::http::StatusCode;
use axum::response::IntoResponse;
use prometheus::{
    Encoder, HistogramOpts, HistogramVec, IntCounterVec, IntGauge, Opts, Registry, TextEncoder,
};

/// Process-wide metrics registry and collectors.
pub struct AppMetrics {
    pub registry: Registry,
    pub http_requests: IntCounterVec,
    pub http_duration_seconds: HistogramVec,
    pub db_pool_size: IntGauge,
    pub db_pool_idle: IntGauge,
    pub agents_online: IntGauge,
    pub ws_viewers_total: IntGauge,
}

impl AppMetrics {
    pub fn new() -> anyhow::Result<Arc<Self>> {
        let registry = Registry::new();

        let http_requests = IntCounterVec::new(
            Opts::new("vantyr_http_requests_total", "HTTP requests processed"),
            &["method", "status"],
        )?;
        registry.register(Box::new(http_requests.clone()))?;

        let http_duration_seconds = HistogramVec::new(
            HistogramOpts::new(
                "vantyr_http_request_duration_seconds",
                "HTTP request duration in seconds",
            )
            .buckets(vec![
                0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
            ]),
            &["method"],
        )?;
        registry.register(Box::new(http_duration_seconds.clone()))?;

        let db_pool_size = IntGauge::with_opts(Opts::new(
            "vantyr_db_pool_connections",
            "SQLx postgres pool size (max connections)",
        ))?;
        registry.register(Box::new(db_pool_size.clone()))?;

        let db_pool_idle = IntGauge::with_opts(Opts::new(
            "vantyr_db_pool_connections_idle",
            "SQLx postgres pool idle connections",
        ))?;
        registry.register(Box::new(db_pool_idle.clone()))?;

        let agents_online = IntGauge::with_opts(Opts::new(
            "vantyr_agents_online",
            "Number of agents connected via WebSocket",
        ))?;
        registry.register(Box::new(agents_online.clone()))?;

        let ws_viewers_total = IntGauge::with_opts(Opts::new(
            "vantyr_dashboard_viewers_ws",
            "Approximate MJPEG viewer sessions (sum of per-agent viewer counts)",
        ))?;
        registry.register(Box::new(ws_viewers_total.clone()))?;

        Ok(Arc::new(Self {
            registry,
            http_requests,
            http_duration_seconds,
            db_pool_size,
            db_pool_idle,
            agents_online,
            ws_viewers_total,
        }))
    }

    pub fn render(&self) -> anyhow::Result<String> {
        let encoder = TextEncoder::new();
        let mut buf = Vec::new();
        encoder.encode(&self.registry.gather(), &mut buf)?;
        Ok(String::from_utf8(buf)?)
    }
}

pub fn metrics_endpoint(metrics: Arc<AppMetrics>) -> impl IntoResponse {
    match metrics.render() {
        Ok(body) => (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, prometheus::TEXT_FORMAT)],
            body,
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("metrics error: {e}"),
        )
            .into_response(),
    }
}
