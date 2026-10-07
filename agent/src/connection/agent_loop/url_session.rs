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

/// Time-on-site tracking for the active browser tab.
#[derive(Default)]
pub(super) struct UrlTracker {
    /// The open time-on-site session, if any.
    session: Option<UrlSession>,
    /// Set while AFK: no session is open and none starts until activity.
    pub(super) blocked_by_afk: bool,
    /// Last live `url` sample queued, so only changes are sent.
    last_live_key: Option<String>,
}

impl UrlTracker {
    /// Forget the open session and the last live sample (grant revoked).
    pub(super) fn reset(&mut self) {
        self.session = None;
        self.last_live_key = None;
    }

    /// Close the open session, if any, as a `url_session` event.
    pub(super) fn end_session(&mut self, pending_events: &mut Vec<serde_json::Value>) {
        if let Some(prev) = self.session.take() {
            let now_ts = crate::unix_timestamp_secs() as i64;
            pending_events.push(url_session_event_value(prev, now_ts));
        }
    }

    /// Sample the active browser URL: open/close time-on-site sessions on
    /// transitions and queue a live `url` event when the tab changes.
    pub(super) fn poll(
        &mut self,
        active_user: &Option<String>,
        pending_events: &mut Vec<serde_json::Value>,
    ) {
        let generation =
            crate::permissions::Generation::capture(crate::permissions::Module::BrowserUrls);
        if self
            .session
            .as_ref()
            .is_some_and(|s| !s.generation.is_some_and(|g| g.valid()))
        {
            self.session = None;
            self.last_live_key = None;
        }
        let now_ts_u64 = crate::unix_timestamp_secs();
        let now_ts = now_ts_u64 as i64;
        let active = if self.blocked_by_afk
            || !crate::permissions::allowed(crate::permissions::Module::BrowserUrls)
        {
            None
        } else {
            crate::platform::url_provider::active_url()
        };

        // Session transitions.
        match (&self.session, &active) {
            (None, Some(info)) => {
                self.session = Some(UrlSession {
                    generation,
                    url: info.url.clone(),
                    title: if info.title.trim().is_empty() {
                        None
                    } else {
                        Some(info.title.clone())
                    },
                    browser: Some(info.browser_name.clone()),
                    user: active_user.clone(),
                    started_at_instant: std::time::Instant::now(),
                    started_at_ts: now_ts,
                });
            }
            (Some(sess), Some(info)) if sess.url != info.url => {
                if let Some(prev) = self.session.take() {
                    pending_events.push(url_session_event_value(prev, now_ts));
                }
                self.session = Some(UrlSession {
                    generation,
                    url: info.url.clone(),
                    title: if info.title.trim().is_empty() {
                        None
                    } else {
                        Some(info.title.clone())
                    },
                    browser: Some(info.browser_name.clone()),
                    user: active_user.clone(),
                    started_at_instant: std::time::Instant::now(),
                    started_at_ts: now_ts,
                });
            }
            (Some(_), None) => {
                if let Some(prev) = self.session.take() {
                    pending_events.push(url_session_event_value(prev, now_ts));
                }
            }
            _ => {}
        }

        // Live URL sample for dashboard + `url_visits` (sessions use `url_session`).
        // Only emit when the URL changes to save WAN bandwidth.
        if let Some(info) = active.filter(|_| generation.is_some_and(|g| g.valid())) {
            let key = format!("{}\n{}\n{}", info.url, info.title, info.browser_name);
            if self.last_live_key.as_deref() != Some(key.as_str()) {
                self.last_live_key = Some(key);
                pending_events.push(crate::permissions::stamp(
                    serde_json::json!({
                        "type"    : "url",
                        "url"     : info.url,
                        "title"   : info.title,
                        "browser" : info.browser_name,
                        "ts"      : now_ts_u64,
                        "user"    : active_user,
                    }),
                    generation,
                ));
            }
        } else {
            self.last_live_key = None;
        }
    }
}
