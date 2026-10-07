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
