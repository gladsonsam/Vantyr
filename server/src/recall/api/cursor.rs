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
#[cfg(test)]
mod pagination_tests {
    use super::*;
    use chrono::Duration;

    fn context(query: Option<&str>) -> HistoryCursor {
        page_context(
            Uuid::nil(),
            query,
            Some("2026-01-01T00:00:00Z".into()),
            Some("2026-01-02T00:00:00Z".into()),
            Some(1),
            None,
            None,
            None,
        )
        .unwrap()
    }

    fn token(query: Option<&str>) -> String {
        let c = context(query);
        let position = db::timeline::ScreenFramePosition {
            captured_at: c.from.unwrap() + Duration::microseconds(123456),
            id: 42,
            rank: query.map(|_| 0.06079271_f32),
        };
        next_cursor(c, Some(position)).unwrap()
    }

    #[test]
    fn round_trip_preserves_microseconds_and_exact_postgres_rank() {
        let raw = token(Some("needle"));
        let c = decode_cursor(Some(&raw)).unwrap().unwrap();
        assert_eq!(c.position.captured_at.timestamp_subsec_micros(), 123456);
        assert_eq!(c.position.rank.unwrap().to_bits(), 0.06079271_f32.to_bits());
    }

    #[test]
    fn maximum_query_with_json_escapes_has_a_usable_cursor() {
        let query = "\u{0001}".repeat(4096);
        let raw = token(Some(&query));
        assert!(decode_cursor(Some(&raw)).is_ok());
    }

    #[test]
    fn continuation_inherits_fixed_bounds_and_filters() {
        let raw = token(None);
        let c = page_context(Uuid::nil(), None, None, None, None, None, None, Some(&raw)).unwrap();
        assert_eq!(c.from, context(None).from);
        assert_eq!(c.to, context(None).to);
        assert_eq!(c.monitor, Some(1));
    }

    #[test]
    fn cursor_rejects_changed_device_query_range_monitor_scope_and_sort() {
        let raw = token(Some("needle"));
        for (agent, query, from, to, monitor, scope, sort) in [
            (Uuid::new_v4(), "needle", None, None, None, None, None),
            (Uuid::nil(), "different", None, None, None, None, None),
            (
                Uuid::nil(),
                "needle",
                Some("2025-01-01T00:00:00Z"),
                None,
                None,
                None,
                None,
            ),
            (
                Uuid::nil(),
                "needle",
                None,
                Some("2026-01-03T00:00:00Z"),
                None,
                None,
                None,
            ),
            (Uuid::nil(), "needle", None, None, Some(0), None, None),
            (
                Uuid::nil(),
                "needle",
                None,
                None,
                None,
                Some("retained"),
                None,
            ),
            (
                Uuid::nil(),
                "needle",
                None,
                None,
                None,
                None,
                Some("newest"),
            ),
        ] {
            assert!(page_context(
                agent,
                Some(query),
                from.map(str::to_owned),
                to.map(str::to_owned),
                monitor,
                scope,
                sort,
                Some(&raw)
            )
            .is_err());
        }
        let raw = token(None);
        assert!(page_context(
            Uuid::nil(),
            Some("needle"),
            None,
            None,
            None,
            None,
            None,
            Some(&raw)
        )
        .is_err());
    }

    #[test]
    fn invalid_cursor_and_position_are_rejected() {
        for raw in ["", "not-base64!", "e30"] {
            assert!(decode_cursor(Some(raw)).is_err());
        }
        assert!(decode_cursor(Some(&"a".repeat(65_537))).is_err());
        for mutation in 0..5 {
            let mut c = decode_cursor(Some(&token(Some("needle"))))
                .unwrap()
                .unwrap();
            match mutation {
                0 => c.version = 3,
                1 => c.position.id = 0,
                2 => c.position.captured_at = c.to + Duration::seconds(1),
                3 => c.position.rank = None,
                _ => c.position.rank = Some(-1.0),
            }
            let raw = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&c).unwrap());
            assert!(decode_cursor(Some(&raw)).is_err());
        }
    }

    #[test]
    fn retained_scope_is_explicit_and_cannot_accept_from() {
        let c = page_context(
            Uuid::nil(),
            Some("needle"),
            None,
            None,
            None,
            Some("retained"),
            Some("newest"),
            None,
        )
        .unwrap();
        assert!(c.from.is_none());
        let raw = next_cursor(
            c,
            Some(db::timeline::ScreenFramePosition {
                captured_at: DateTime::parse_from_rfc3339("2000-01-01T00:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc),
                id: 1,
                rank: Some(0.1),
            }),
        )
        .unwrap();
        let c = page_context(
            Uuid::nil(),
            Some("needle"),
            None,
            None,
            None,
            None,
            None,
            Some(&raw),
        )
        .unwrap();
        assert_eq!(c.scope, "retained");
        assert_eq!(c.sort, "newest");
        assert!(page_context(
            Uuid::nil(),
            Some("needle"),
            Some("2026-01-01T00:00:00Z".into()),
            None,
            None,
            Some("retained"),
            None,
            None
        )
        .is_err());
    }

    #[test]
    fn invalid_filters_are_rejected_and_legacy_defaults_preserved() {
        let c = page_context(
            Uuid::nil(),
            Some("needle"),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(c.sort, "ranked");
        assert_eq!(c.to - c.from.unwrap(), Duration::days(1));
        for (monitor, scope, sort) in [
            (Some(-1), None, None),
            (None, Some("all"), None),
            (None, None, Some("oldest")),
        ] {
            assert!(page_context(
                Uuid::nil(),
                Some("needle"),
                None,
                None,
                monitor,
                scope,
                sort,
                None
            )
            .is_err());
        }
        assert!(next_cursor(context(None), None).is_none());
    }
}

#[cfg(test)]
#[cfg(test)]
mod context_cursor_tests {
    use super::*;
    use chrono::TimeZone;
    fn cursor(request: ContextFilterQuery, query: &str) -> String {
        let c = filtered_page_context(
            Uuid::nil(),
            Some(query),
            Some("2026-01-01T00:00:00Z".into()),
            Some("2026-01-02T00:00:00Z".into()),
            None,
            None,
            None,
            None,
            &request,
        )
        .unwrap();
        next_cursor(
            c,
            Some(db::timeline::ScreenFramePosition {
                captured_at: Utc.with_ymd_and_hms(2026, 1, 1, 1, 0, 0).unwrap(),
                id: 2,
                rank: Some(0.0),
            }),
        )
        .unwrap()
    }
    #[test]
    fn context_only_freezes_filters_and_rejects_changes_clears_and_ranked() {
        let request = ContextFilterQuery {
            app: Some("Editor.EXE".into()),
            ..Default::default()
        };
        let token = cursor(request, "");
        let decoded = decode_cursor(Some(&token)).unwrap().unwrap();
        assert_eq!(decoded.version, 2);
        assert_eq!(decoded.sort, "newest");
        assert_eq!(decoded.filters.app.as_deref(), Some("editor.exe"));
        let inherited = filtered_page_context(
            Uuid::nil(),
            Some(""),
            None,
            None,
            None,
            None,
            None,
            Some(&token),
            &ContextFilterQuery::default(),
        )
        .unwrap();
        assert_eq!(inherited.filters, decoded.filters);
        for request in [
            ContextFilterQuery {
                app: Some("".into()),
                ..Default::default()
            },
            ContextFilterQuery {
                title: Some("changed".into()),
                ..Default::default()
            },
            ContextFilterQuery {
                app_mode: Some("prefix".into()),
                ..Default::default()
            },
            ContextFilterQuery {
                context: Some("known".into()),
                ..Default::default()
            },
        ] {
            assert!(filtered_page_context(
                Uuid::nil(),
                Some(""),
                None,
                None,
                None,
                None,
                None,
                Some(&token),
                &request
            )
            .is_err());
        }
        let known = ContextFilterQuery {
            context: Some("known".into()),
            ..Default::default()
        };
        assert!(filtered_page_context(
            Uuid::nil(),
            Some(""),
            None,
            None,
            None,
            None,
            Some("ranked"),
            None,
            &known
        )
        .is_err());
        assert!(filtered_page_context(
            Uuid::nil(),
            Some(""),
            None,
            None,
            None,
            None,
            None,
            None,
            &ContextFilterQuery::default()
        )
        .is_err());
        assert!(ContextFilterQuery {
            app_mode: Some("exact".into()),
            ..Default::default()
        }
        .resolve(None)
        .is_err());
        assert!(ContextFilterQuery {
            context: Some("unknown".into()),
            app: Some("editor".into()),
            ..Default::default()
        }
        .resolve(None)
        .is_err());
    }
    #[test]
    fn v1_unfiltered_support_does_not_authorize_context_filters() {
        let token = cursor(ContextFilterQuery::default(), "needle");
        let mut value: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(token).unwrap()).unwrap();
        value["version"] = serde_json::json!(1);
        value.as_object_mut().unwrap().remove("filters");
        let token = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap());
        assert!(filtered_page_context(
            Uuid::nil(),
            Some("needle"),
            None,
            None,
            None,
            None,
            None,
            Some(&token),
            &ContextFilterQuery::default()
        )
        .is_ok());
        assert!(filtered_page_context(
            Uuid::nil(),
            Some("needle"),
            None,
            None,
            None,
            None,
            None,
            Some(&token),
            &ContextFilterQuery {
                context: Some("known".into()),
                ..Default::default()
            }
        )
        .is_err());
    }
    #[test]
    fn maximum_combined_escaped_fields_fit_bounded_cursor() {
        let q = "\u{1}".repeat(4096);
        let token = cursor(
            ContextFilterQuery {
                app: Some("\\".repeat(256)),
                title: Some("\\".repeat(1024)),
                url_host: Some(format!(
                    "{}.{}.{}.{}",
                    "a".repeat(63),
                    "b".repeat(63),
                    "c".repeat(63),
                    "d".repeat(61)
                )),
                ..Default::default()
            },
            &q,
        );
        assert!(token.len() > 8192 && token.len() < 65536);
        assert!(decode_cursor(Some(&token)).is_ok());
        assert!(decode_cursor(Some(&"a".repeat(65537))).is_err());
    }
}
