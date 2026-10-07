//! Versioned keyset cursors for frame listing and search, bound to the request filters.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::recall::db;

use super::parse_range;

/// Versioned, URL-safe cursor. Bound to the device, query and effective filters;
/// it freezes default time bounds across requests. This is not a DB snapshot.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HistoryCursor {
    pub(super) version: u8,
    pub(super) agent_id: Uuid,
    pub(super) query: Option<String>,
    pub(super) from: Option<DateTime<Utc>>,
    pub(super) to: DateTime<Utc>,
    pub(super) monitor: Option<i32>,
    pub(super) scope: String,
    pub(super) sort: String,
    pub(super) position: db::timeline::ScreenFramePosition,
    #[serde(default)]
    pub(super) filters: crate::recall::context::Filters,
}

pub(super) fn decode_cursor(raw: Option<&str>) -> Result<Option<HistoryCursor>, &'static str> {
    let Some(raw) = raw else { return Ok(None) };
    if raw.len() > 65_536 {
        return Err("invalid cursor");
    }
    let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| "invalid cursor")?;
    let c: HistoryCursor = serde_json::from_slice(&bytes).map_err(|_| "invalid cursor")?;
    if !matches!(c.version, 1 | 2)
        || c.filters.validate().is_err()
        || (c.version == 1 && c.filters.active())
        || c.position.id <= 0
        || c.from
            .is_some_and(|from| from > c.to || c.position.captured_at < from)
        || c.position.captured_at > c.to
        || c.monitor.is_some_and(|m| m < 0)
        || !matches!(c.scope.as_str(), "range" | "retained")
        || (c.scope == "range") != c.from.is_some()
        || match c.query.as_ref() {
            None => {
                c.sort != "oldest"
                    || c.scope != "range"
                    || c.position.rank.is_some()
                    || c.filters.active()
            }
            Some(q) => {
                q.len() > 4096
                    || (q.is_empty()
                        && (c.version != 2
                            || !c.filters.active()
                            || c.sort != "newest"
                            || c.position.rank != Some(0.0)))
                    || q.trim() != q
                    || !matches!(c.sort.as_str(), "ranked" | "newest")
                    || !c.position.rank.is_some_and(|r| r.is_finite() && r >= 0.0)
            }
        }
    {
        return Err("invalid cursor");
    }
    Ok(Some(c))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn page_context(
    agent_id: Uuid,
    query: Option<&str>,
    from: Option<String>,
    to: Option<String>,
    monitor: Option<i32>,
    scope: Option<&str>,
    sort: Option<&str>,
    raw_cursor: Option<&str>,
) -> Result<HistoryCursor, &'static str> {
    filtered_page_context(
        agent_id,
        query,
        from,
        to,
        monitor,
        scope,
        sort,
        raw_cursor,
        &ContextFilterQuery::default(),
    )
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct ContextFilterQuery {
    app: Option<String>,
    app_mode: Option<String>,
    title: Option<String>,
    url_host: Option<String>,
    context: Option<String>,
}

impl ContextFilterQuery {
    fn resolve(
        &self,
        previous: Option<&crate::recall::context::Filters>,
    ) -> Result<crate::recall::context::Filters, &'static str> {
        let mut f = previous.cloned().unwrap_or_default();
        if let Some(app) = &self.app {
            f.app = (!app.trim().is_empty()).then(|| app.trim().to_ascii_lowercase());
        }
        if let Some(mode) = &self.app_mode {
            f.app_mode = mode.clone();
        }
        if let Some(title) = &self.title {
            f.title = (!title.trim().is_empty()).then(|| title.trim().to_owned());
        }
        if let Some(host) = &self.url_host {
            f.url_host = if host.trim().is_empty() {
                None
            } else {
                Some(crate::recall::context::normalize_host(host.trim())?)
            };
        }
        if let Some(context) = &self.context {
            f.context = context.clone();
        }
        if self.app_mode.is_some() && f.app.is_none() {
            return Err("app_mode requires app");
        }
        f.validate()?;
        if previous.is_some_and(|old| old != &f) {
            return Err("cursor does not match context filters");
        }
        Ok(f)
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn filtered_page_context(
    agent_id: Uuid,
    query: Option<&str>,
    from: Option<String>,
    to: Option<String>,
    monitor: Option<i32>,
    scope: Option<&str>,
    sort: Option<&str>,
    raw_cursor: Option<&str>,
    requested: &ContextFilterQuery,
) -> Result<HistoryCursor, &'static str> {
    let cursor = decode_cursor(raw_cursor)?;
    let filters = requested.resolve(cursor.as_ref().map(|c| &c.filters))?;
    if query == Some("") && !filters.active() {
        return Err("missing search query or context filters");
    }
    let scope = scope
        .or_else(|| cursor.as_ref().map(|c| c.scope.as_str()))
        .unwrap_or("range");
    let sort = sort
        .or_else(|| cursor.as_ref().map(|c| c.sort.as_str()))
        .unwrap_or(if query == Some("") {
            "newest"
        } else if query.is_some() {
            "ranked"
        } else {
            "oldest"
        });
    if !matches!(scope, "range" | "retained") || (query.is_none() && scope != "range") {
        return Err("invalid 'scope' (expected range or retained)");
    }
    if (query == Some("") && sort != "newest")
        || (query.is_some() && !matches!(sort, "ranked" | "newest"))
        || (query.is_none() && sort != "oldest")
    {
        return Err("invalid 'sort' (expected ranked or newest)");
    }
    if monitor.is_some_and(|m| m < 0) {
        return Err("invalid 'monitor' (must be non-negative)");
    }
    if scope == "retained" && from.is_some() {
        return Err("'from' is incompatible with scope=retained");
    }
    let from = from.or_else(|| cursor.as_ref().and_then(|c| c.from.map(|v| v.to_rfc3339())));
    let to = to.or_else(|| cursor.as_ref().map(|c| c.to.to_rfc3339()));
    let (start, end) = parse_range(from, to)?;
    let from = if scope == "retained" {
        None
    } else {
        Some(start)
    };
    let monitor = monitor.or_else(|| cursor.as_ref().and_then(|c| c.monitor));
    if let Some(c) = cursor.as_ref() {
        if c.agent_id != agent_id
            || c.query.as_deref() != query
            || c.from != from
            || c.to != end
            || c.monitor != monitor
            || c.scope != scope
            || c.sort != sort
        {
            return Err("cursor does not match request filters");
        }
        return Ok(cursor.expect("validated cursor"));
    }
    Ok(HistoryCursor {
        version: 2,
        filters,
        agent_id,
        query: query.map(str::to_owned),
        from,
        to: end,
        monitor,
        scope: scope.to_owned(),
        sort: sort.to_owned(),
        // Placeholder on first page; only used after replacement with a DB position.
        position: db::timeline::ScreenFramePosition {
            captured_at: start,
            id: 0,
            rank: None,
        },
    })
}

pub(super) fn next_cursor(
    mut context: HistoryCursor,
    position: Option<db::timeline::ScreenFramePosition>,
) -> Option<String> {
    position.map(|position| {
        context.position = position;
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&context).expect("serializable history cursor"))
    })
}

#[cfg(test)]
mod pagination_tests;

#[cfg(test)]
mod context_cursor_tests;
