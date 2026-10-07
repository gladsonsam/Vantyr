//! Time-on-site URL sessions, emitted as `url_session` events on transitions.

#[derive(Debug, Clone)]
pub(super) struct UrlSession {
    pub(super) url: String,
    pub(super) title: Option<String>,
    pub(super) browser: Option<String>,
    pub(super) user: Option<String>,
    pub(super) started_at_instant: std::time::Instant,
    pub(super) started_at_ts: i64,
    pub(super) generation: Option<crate::permissions::Generation>,
}

pub(super) fn url_session_event_value(sess: UrlSession, ended_at_ts: i64) -> serde_json::Value {
    let duration_ms = sess
        .started_at_instant
        .elapsed()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64;
    crate::permissions::stamp(
        serde_json::json!({
            "type": "url_session",
            "url": sess.url,
            "title": sess.title,
            "browser": sess.browser,
            "user": sess.user,
            "started_at_ts": sess.started_at_ts,
            "ended_at_ts": ended_at_ts,
            "duration_ms": duration_ms,
        }),
        sess.generation,
    )
}
