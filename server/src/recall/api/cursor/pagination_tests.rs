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
