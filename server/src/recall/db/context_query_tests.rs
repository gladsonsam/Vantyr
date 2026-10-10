use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use super::frames::insert_screen_frame;
use super::search::search_screen_frames_filtered_page;
use super::timeline::{list_screen_frames_page, screen_frame_at};
use crate::recall::context::{Filters, Metadata};
use crate::test_support::recall::{fixture, frame_header as header};
use chrono::TimeZone;

async fn add(
    pool: &PgPool,
    agent: Uuid,
    at: DateTime<Utc>,
    monitor: i32,
    h: &serde_json::Value,
) -> i64 {
    let m = crate::recall::context::sanitize(h, Some(12), Some(9));
    insert_screen_frame(
        pool,
        agent,
        at,
        monitor,
        100,
        100,
        0,
        "fixture.jpg",
        Some("needle"),
        None,
        Some(Uuid::new_v4()),
        &m,
    )
    .await
    .unwrap()
    .unwrap()
}
async fn search(pool: &PgPool, agent: Uuid, q: &str, f: &Filters) -> Vec<serde_json::Value> {
    search_screen_frames_filtered_page(
        pool,
        agent,
        q,
        None,
        Utc.with_ymd_and_hms(2027, 1, 1, 0, 0, 0).unwrap(),
        None,
        100,
        true,
        None,
        f,
    )
    .await
    .unwrap()
    .items
    .into_iter()
    .map(|item| serde_json::to_value(item).unwrap())
    .collect()
}
#[sqlx::test(migrations = false)]
async fn recall_context_literal_filters_unicode_known_unknown_and_legacy_null(db: PgPool) {
    let (s, agent, _, _) = fixture(db).await;
    let at = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
    let a = add(&s.db, agent, at, 0, &header()).await;
    let mut h = header();
    h["context"]["window"]["app"] = serde_json::json!("Editor%_special.EXE");
    h["context"]["window"]["title"] = serde_json::json!("文档 100percentXdone École");
    h["context"]["browser"]["url_host"] = serde_json::json!("a.example.com");
    let b = add(&s.db, agent, at, 1, &h).await;
    let other = Uuid::new_v4();
    crate::test_support::insert_agent(&s.db, other)
        .await
        .unwrap();
    add(&s.db, other, at, 0, &header()).await;
    let legacy = insert_screen_frame(
        &s.db,
        agent,
        at,
        0,
        100,
        100,
        0,
        "legacy.jpg",
        None,
        None,
        None,
        &Metadata::default(),
    )
    .await
    .unwrap()
    .unwrap();
    let exact = Filters {
        app: Some("editor.exe".into()),
        ..Default::default()
    };
    let rows = search(&s.db, agent, "", &exact).await;
    assert_eq!(
        rows.iter()
            .map(|r| r["id"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![a]
    );
    assert_eq!(rows[0]["rank"], 0.0);
    assert_eq!(rows[0]["snippet"], "");
    assert_eq!(rows[0]["context"]["window"]["app"], "Editor.EXE");
    assert_eq!(rows[0]["capture_duration_ms"], 24);
    let prefix = Filters {
        app: Some("editor%_".into()),
        app_mode: "prefix".into(),
        ..Default::default()
    };
    assert_eq!(search(&s.db, agent, "", &prefix).await[0]["id"], b);
    let literal = Filters {
        title: Some("100%_done".into()),
        ..Default::default()
    };
    assert_eq!(search(&s.db, agent, "", &literal).await[0]["id"], a);
    let unicode = Filters {
        title: Some("文档".into()),
        ..Default::default()
    };
    assert_eq!(search(&s.db, agent, "", &unicode).await.len(), 2);
    let ascii = Filters {
        title: Some("PERCENTxdONE".into()),
        ..Default::default()
    };
    assert_eq!(search(&s.db, agent, "", &ascii).await[0]["id"], b);
    let unicode_fold = Filters {
        title: Some("école".into()),
        ..Default::default()
    };
    assert!(
        search(&s.db, agent, "", &unicode_fold).await.is_empty(),
        "C collation does not promise Unicode casefolding"
    );
    let host = Filters {
        url_host: Some("example.com".into()),
        ..Default::default()
    };
    assert_eq!(search(&s.db, agent, "", &host).await[0]["id"], a);
    let known = Filters {
        context: "known".into(),
        ..Default::default()
    };
    assert_eq!(search(&s.db, agent, "", &known).await.len(), 2);
    let unknown = Filters {
        context: "unknown".into(),
        ..Default::default()
    };
    let unknown_rows = search(&s.db, agent, "", &unknown).await;
    assert_eq!(unknown_rows.len(), 2); // pre-migration row and new legacy row
    assert!(unknown_rows.iter().any(|r| r["id"] == legacy));
    assert!(unknown_rows
        .iter()
        .all(|r| r["context"].is_null() && r["capture_duration_ms"].is_null()));
    assert_eq!(search(&s.db, agent, "needle", &exact).await.len(), 1);
    assert!(search(&s.db, agent, "absent", &exact).await.is_empty());
    let at_frame = screen_frame_at(&s.db, agent, at, Some(1))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(at_frame.id, b);
    assert!(at_frame.context.as_ref().is_some_and(|c| c.is_object()));
    let list = list_screen_frames_page(&s.db, agent, at, at, None, 20, None)
        .await
        .unwrap();
    assert_eq!(list.items.len(), 3);
}
#[sqlx::test(migrations = false)]
async fn recall_context_tied_keysets_cover_all_filters_and_device_monitor_isolation(db: PgPool) {
    let (s, agent, _, _) = fixture(db).await;
    let at =
        Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap() + chrono::Duration::microseconds(123456);
    let mut expected = Vec::new();
    for n in 0..7 {
        expected.push(add(&s.db, agent, at, n % 2, &header()).await);
    }
    let other = Uuid::new_v4();
    crate::test_support::insert_agent(&s.db, other)
        .await
        .unwrap();
    add(&s.db, other, at, 0, &header()).await;
    let f = Filters {
        app: Some("editor.exe".into()),
        title: Some("100%_".into()),
        url_host: Some("example.com".into()),
        context: "known".into(),
        ..Default::default()
    };
    for (q, newest) in [("", true), ("needle", true), ("needle", false)] {
        let mut after = None;
        let mut seen = Vec::new();
        loop {
            let page = search_screen_frames_filtered_page(
                &s.db,
                agent,
                q,
                None,
                at,
                None,
                2,
                newest,
                after.as_ref(),
                &f,
            )
            .await
            .unwrap();
            seen.extend(page.items.iter().map(|r| r.id));
            if page.next.is_none() {
                break;
            }
            after = page.next;
        }
        let mut ordered = expected.clone();
        ordered.reverse();
        assert_eq!(seen, ordered);
    }
    let page = search_screen_frames_filtered_page(
        &s.db,
        agent,
        "",
        None,
        at,
        Some(1),
        100,
        true,
        None,
        &f,
    )
    .await
    .unwrap();
    assert_eq!(page.items.len(), 3);
    assert!(page.items.iter().all(|r| r.monitor == 1));
    let page =
        search_screen_frames_filtered_page(&s.db, agent, "", None, at, None, 7, true, None, &f)
            .await
            .unwrap();
    assert_eq!(page.items.len(), 7);
    assert!(page.next.is_none());
}
