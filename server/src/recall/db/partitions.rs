//! Day partitions of `screen_frames`: on-demand creation and retention pruning.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use anyhow::Result;
use chrono::{Datelike, Duration, NaiveDate};
use sqlx::PgPool;
use uuid::Uuid;

/// Partitions this process has already ensured exist (keyed by proleptic-Gregorian
/// day number) so we run the `CREATE TABLE … PARTITION OF` DDL at most once per day.
fn ensured_partitions() -> &'static Mutex<HashSet<i32>> {
    static S: OnceLock<Mutex<HashSet<i32>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Create the day partition covering `day` (UTC) if it does not already exist.
///
/// Idempotent and cheap after the first call per day (in-memory guard). A failure
/// here is non-fatal: the parent's DEFAULT partition still accepts the insert.
pub async fn ensure_screen_frame_partition(pool: &PgPool, day: NaiveDate) -> Result<()> {
    let key = day.num_days_from_ce();
    if ensured_partitions().lock().unwrap().contains(&key) {
        return Ok(());
    }
    let end = day.succ_opt().unwrap_or(day);
    let name = format!("screen_frames_{}", day.format("%Y%m%d"));
    // Bounds are explicit UTC so they line up with the UTC `captured_at` values,
    // independent of the session TimeZone. Values are server-generated (date only),
    // never user input, so the format!-built DDL carries no injection surface.
    let ddl = format!(
        "CREATE TABLE IF NOT EXISTS {name} PARTITION OF screen_frames \
         FOR VALUES FROM ('{} 00:00:00+00') TO ('{} 00:00:00+00')",
        day.format("%Y-%m-%d"),
        end.format("%Y-%m-%d"),
    );
    sqlx::query(&ddl).execute(pool).await?;
    ensured_partitions().lock().unwrap().insert(key);
    Ok(())
}

/// Drop a bounded batch of old partitions belonging to the resolved parent only.
/// Blob cleanup is coordinated separately under device lifecycle gates.
pub async fn prune_screen_history_partitions(pool: &PgPool, cutoff: NaiveDate) -> Result<u64> {
    let mut tx = pool.begin().await?;
    sqlx::query!(r#"SET LOCAL statement_timeout = '2s'"#)
        .execute(&mut *tx)
        .await?;
    sqlx::query!(r#"SET LOCAL lock_timeout = '1s'"#)
        .execute(&mut *tx)
        .await?;
    let rows = sqlx::query!(
        r#"SELECT c.relname::text AS "name!", n.nspname::text AS "schema!"
         FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
         JOIN pg_partitioned_table p ON p.partrelid=i.inhparent
         JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE i.inhparent='screen_frames'::regclass AND c.relispartition
           AND c.oid<>p.partdefid
           AND c.relname ~ '^screen_frames_[0-9]{8}$'
           AND CASE WHEN pg_input_is_valid(substring(c.relname FROM 15), 'date')
               THEN substring(c.relname FROM 15)::date END < $1
         ORDER BY c.relname LIMIT 4"#,
        cutoff
    )
    .fetch_all(&mut *tx)
    .await?;
    let mut dropped = Vec::new();
    for row in rows {
        let (name, schema) = (row.name, row.schema);
        let Some(datestr) = name.strip_prefix("screen_frames_") else {
            continue;
        };
        let Ok(day) = NaiveDate::parse_from_str(datestr, "%Y%m%d") else {
            continue;
        };
        if day >= cutoff || day.format("%Y%m%d").to_string() != datestr {
            continue;
        }
        let qualified = format!(
            "\"{}\".\"{}\"",
            schema.replace('"', "\"\""),
            name.replace('"', "\"\"")
        );
        sqlx::query(&format!("DROP TABLE {qualified}"))
            .execute(&mut *tx)
            .await?;
        dropped.push(day);
    }
    tx.commit().await?;
    for day in &dropped {
        ensured_partitions()
            .lock()
            .unwrap()
            .remove(&day.num_days_from_ce());
    }
    Ok(dropped.len() as u64)
}

/// One committed DEFAULT-row batch, never a claim of complete reconciliation.
#[derive(Debug, Default)]
pub struct DefaultPruneBatch {
    pub deleted: u64,
    pub pending: bool,
}

pub const DEFAULT_PRUNE_ROWS: i64 = 256;

/// Resolve and lock catalog identities before using qualified names. Parent SUE
/// excludes partition DDL while permitting ordinary ingestion. Row locks skip
/// busy rows; ctid is used only within this transaction and this leaf relation.
pub async fn prune_screen_history_default(
    pool: &PgPool,
    cutoff: NaiveDate,
) -> Result<DefaultPruneBatch> {
    let mut tx = pool.begin().await?;
    sqlx::query!(r#"SET LOCAL statement_timeout = '2s'"#)
        .execute(&mut *tx)
        .await?;
    sqlx::query!(r#"SET LOCAL lock_timeout = '1s'"#)
        .execute(&mut *tx)
        .await?;
    let parent = sqlx::query!(
        r#"SELECT c.oid::bigint AS "oid!", c.relname::text AS "name!", n.nspname::text AS "schema!"
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE c.oid='screen_frames'::regclass"#
    )
    .fetch_one(&mut *tx)
    .await?;
    let qualify = |schema: &str, name: &str| -> String {
        format!(
            "\"{}\".\"{}\"",
            schema.replace('"', "\"\""),
            name.replace('"', "\"\"")
        )
    };
    let parent_name = qualify(&parent.schema, &parent.name);
    let parent_oid: i64 = parent.oid;
    sqlx::query(&format!(
        "LOCK TABLE ONLY {parent_name} IN SHARE UPDATE EXCLUSIVE MODE"
    ))
    .execute(&mut *tx)
    .await?;
    let supported: bool = sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 FROM pg_partitioned_table p
         JOIN pg_attribute a ON a.attrelid=p.partrelid AND a.attnum=p.partattrs[0]
         WHERE p.partrelid=$1::bigint::oid AND p.partstrat='r' AND p.partnatts=1
           AND a.attname='captured_at' AND a.atttypid IN ('date'::regtype,'timestamptz'::regtype)
           AND p.partrelid=to_regclass($2)) AS "exists!""#,
        parent_oid,
        &parent_name
    )
    .fetch_one(&mut *tx)
    .await?;
    anyhow::ensure!(
        supported,
        "unsupported screen_frames partition structure or changed parent identity"
    );
    let child = sqlx::query!(
        r#"SELECT c.oid::bigint AS "oid!", c.relname::text AS "name!", n.nspname::text AS "schema!",
                c.relkind::text AS "kind!"
         FROM pg_partitioned_table p JOIN pg_inherits i
           ON i.inhparent=p.partrelid AND i.inhrelid=p.partdefid
         JOIN pg_class c ON c.oid=i.inhrelid
         JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE p.partrelid=$1::bigint::oid AND c.relispartition"#,
        parent_oid
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(child) = child else {
        tx.commit().await?;
        return Ok(DefaultPruneBatch::default());
    };
    anyhow::ensure!(
        child.kind == "r",
        "unsupported screen_frames DEFAULT child: expected ordinary leaf table"
    );
    let child_name = qualify(&child.schema, &child.name);
    let child_oid: i64 = child.oid;
    sqlx::query(&format!(
        "LOCK TABLE ONLY {child_name} IN ROW EXCLUSIVE MODE"
    ))
    .execute(&mut *tx)
    .await?;
    let same: bool = sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 FROM pg_partitioned_table p JOIN pg_inherits i
          ON i.inhparent=p.partrelid AND i.inhrelid=p.partdefid
          WHERE p.partrelid=$1::bigint::oid AND i.inhrelid=$2::bigint::oid
            AND i.inhrelid=to_regclass($3)) AS "exists!""#,
        parent_oid,
        child_oid,
        &child_name
    )
    .fetch_one(&mut *tx)
    .await?;
    anyhow::ensure!(same, "screen_frames DEFAULT child identity changed");
    // Bind an actual UTC instant, independent of the session TimeZone. DATE
    // fixtures compare with the same UTC day because the transaction uses UTC.
    sqlx::query!(r#"SET LOCAL TIME ZONE 'UTC'"#)
        .execute(&mut *tx)
        .await?;
    let before = cutoff.and_hms_opt(0, 0, 0).unwrap().and_utc();
    // Runtime queries: the DEFAULT child's name is only known at run time.
    let deleted = sqlx::query(&format!(
        "WITH batch AS MATERIALIZED (
           SELECT ctid FROM ONLY {child_name} WHERE captured_at < $1
           ORDER BY captured_at, ctid LIMIT $2 FOR UPDATE SKIP LOCKED
         ) DELETE FROM ONLY {child_name} f USING batch b
           WHERE f.ctid=b.ctid AND f.captured_at < $1"
    ))
    .bind(before)
    .bind(DEFAULT_PRUNE_ROWS)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let pending = sqlx::query_scalar(&format!(
        "SELECT EXISTS(SELECT 1 FROM ONLY {child_name} WHERE captured_at < $1)"
    ))
    .bind(before)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(DefaultPruneBatch { deleted, pending })
}

/// Check references across ALL partitions, including the default partition.
/// Ingestion derives `<agent>/<YYYYMMDD>/` from the row's own agent and UTC
/// `captured_at`, so the owner/time bounds (with a day of margin each side)
/// use idx_screen_frames_agent_ts instead of scanning every row's blob_ref.
pub async fn screen_history_day_is_indexed(
    pool: &PgPool,
    agent: Uuid,
    day: NaiveDate,
) -> Result<bool> {
    let mut tx = pool.begin().await?;
    sqlx::query!(r#"SET LOCAL statement_timeout = '2s'"#)
        .execute(&mut *tx)
        .await?;
    let prefix = format!("{agent}/{}/%", day.format("%Y%m%d"));
    let from = (day - Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc();
    let to = (day + Duration::days(2))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc();
    let indexed = sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 FROM screen_frames
           WHERE agent_id = $1 AND captured_at >= $2 AND captured_at < $3
             AND blob_ref LIKE $4) AS "exists!""#,
        agent,
        from,
        to,
        prefix
    )
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(indexed)
}
