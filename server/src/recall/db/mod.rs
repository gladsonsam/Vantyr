//! Screen-history ("Recall") frame index + day-partition management + retention.
//!
//! The JPEG bytes live in a filesystem blob store (`SCREEN_HISTORY_DIR`); this
//! module owns only the Postgres *index* rows (`screen_frames`, partitioned by
//! day) and the on-demand creation / DROP of those day partitions. Callers import
//! the submodule they need (`db::timeline`, `db::settings`, ...).
//!
//! `phash` is a `u64` aHash. Postgres has no unsigned 64-bit type, so it is stored
//! as the same 64 bits reinterpreted as `i64` (`u64 as i64`) and reversed on read.

pub mod frames;
pub mod partitions;
pub mod search;
pub mod settings;
pub mod timeline;

#[cfg(test)]
mod pagination_tests {
    use anyhow::Result;
    use chrono::{Duration, TimeZone, Utc};
    use sqlx::PgPool;
    use uuid::Uuid;

    use super::search::search_screen_frames_page;
    use super::timeline::list_screen_frames_page;

    #[sqlx::test]
    async fn keyset_pages_cover_ties_caps_filters_and_search_orders(pool: PgPool) -> Result<()> {
        let agent = Uuid::new_v4();
        let other = Uuid::new_v4();
        crate::test_support::insert_agent(&pool, agent).await?;
        crate::test_support::insert_agent(&pool, other).await?;
        let from = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let to = from + Duration::days(1);
        sqlx::query("INSERT INTO screen_frames (id, agent_id, captured_at, monitor, w, h, phash, blob_ref, ocr_text, ocr_tsv)
            OVERRIDING SYSTEM VALUE
            SELECT n, $1, $2::timestamptz, (n % 2)::int, 100, 100, 0, 'fixture.jpg',
                CASE WHEN n % 3 = 0 THEN 'needle needle needle' ELSE 'needle' END,
                to_tsvector('english', CASE WHEN n % 3 = 0 THEN 'needle needle needle' ELSE 'needle' END)
            FROM generate_series(1, 5003) n")
            .bind(agent).bind(from + Duration::microseconds(123456)).execute(&pool).await?;
        sqlx::query(
            "INSERT INTO screen_frames (id, agent_id, captured_at, monitor, w, h, phash, blob_ref, ocr_text, ocr_tsv)
            OVERRIDING SYSTEM VALUE VALUES
            (6000, $1, $3, 0, 100, 100, 0, 'fixture.jpg', 'needle', to_tsvector('english', 'needle')),
            (6001, $2, $4, 0, 100, 100, 0, 'fixture.jpg', 'needle', to_tsvector('english', 'needle'))",
        )
        .bind(agent)
        .bind(other)
        .bind(from - Duration::days(100))
        .bind(from)
        .execute(&pool)
        .await?;

        let first = list_screen_frames_page(&pool, agent, from, to, None, 5000, None).await?;
        assert_eq!(first.items.len(), 5000);
        assert_eq!(first.next.as_ref().unwrap().id, 5000);
        let last = list_screen_frames_page(&pool, agent, from, to, None, 5000, first.next.as_ref())
            .await?;
        assert_eq!(
            last.items.iter().map(|v| v.id).collect::<Vec<_>>(),
            vec![5001, 5002, 5003]
        );
        assert!(last.next.is_none());
        let client_page = list_screen_frames_page(&pool, agent, from, to, None, 3000, None).await?;
        assert_eq!(client_page.items.len(), 3000);
        let client_tail = list_screen_frames_page(
            &pool,
            agent,
            from,
            to,
            None,
            3000,
            client_page.next.as_ref(),
        )
        .await?;
        assert_eq!(client_tail.items.len(), 2003);
        assert!(client_tail.next.is_none());
        let exact = list_screen_frames_page(&pool, agent, from, to, Some(0), 2501, None).await?;
        assert_eq!(exact.items.len(), 2501);
        assert!(exact.next.is_none(), "exactly full final page is complete");
        assert!(exact.items.iter().all(|v| v.monitor == 0));
        let empty = list_screen_frames_page(&pool, agent, to, to, None, 10, None).await?;
        assert!(empty.items.is_empty() && empty.next.is_none());

        for newest in [false, true] {
            let expected_sql = if newest {
                "SELECT id FROM screen_frames WHERE agent_id=$1 ORDER BY captured_at DESC, id DESC"
            } else {
                "SELECT id FROM screen_frames WHERE agent_id=$1 ORDER BY ts_rank(ocr_tsv, websearch_to_tsquery('english', 'needle')) DESC, captured_at DESC, id DESC"
            };
            let expected: Vec<i64> = sqlx::query_scalar(expected_sql)
                .bind(agent)
                .fetch_all(&pool)
                .await?;
            let mut actual = Vec::new();
            let mut after = None;
            for _ in 0..150 {
                let page = search_screen_frames_page(
                    &pool,
                    agent,
                    "needle",
                    None,
                    to,
                    None,
                    37,
                    newest,
                    after.as_ref(),
                )
                .await?;
                actual.extend(page.items.iter().map(|v| v.id));
                after = page.next;
                if after.is_none() {
                    break;
                }
            }
            assert!(after.is_none(), "pagination must terminate");
            assert_eq!(
                actual, expected,
                "all retained hits exactly once, in stable order"
            );
        }
        let range = search_screen_frames_page(
            &pool,
            agent,
            "needle",
            Some(from),
            to,
            Some(0),
            500,
            false,
            None,
        )
        .await?;
        assert_eq!(range.items.len(), 500);
        assert!(range.next.is_some());
        assert!(range.items.iter().all(|v| v.monitor == 0 && v.id != 6000));
        let stopwords =
            search_screen_frames_page(&pool, agent, "the", None, to, None, 10, false, None).await?;
        assert!(stopwords.items.is_empty() && stopwords.next.is_none());
        Ok(())
    }
}

#[cfg(test)]
mod context_query_tests;
