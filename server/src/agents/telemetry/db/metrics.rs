//! Agent resource samples (CPU, memory, disk): ingest, bucketed history and retention.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use ts_rs::TS;
use uuid::Uuid;

use crate::agents::telemetry::ingest::MetricsSample;

/// Insert one resource sample from a `metrics` WS frame.
pub async fn insert_agent_metrics(pool: &PgPool, agent_id: Uuid, ev: &MetricsSample) -> Result<()> {
    sqlx::query!(
        "INSERT INTO agent_metrics
           (agent_id, cpu_pct, mem_used_mb, mem_total_mb, mem_pct, disk_pct, disk_used_gb, disk_total_gb)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        agent_id,
        ev.cpu_pct,
        ev.mem_used_mb,
        ev.mem_total_mb,
        ev.mem_pct,
        ev.disk_pct,
        ev.disk_used_gb,
        ev.disk_total_gb,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// One chart point of [`query_agent_metrics`] (`points[]` of the metrics history).
#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct MetricsBucket {
    /// Bucket start (unix seconds).
    pub t: i64,
    pub cpu_pct: f32,
    pub mem_pct: f32,
    pub mem_used_mb: i64,
    pub mem_total_mb: i64,
    pub disk_pct: f32,
    pub disk_used_gb: f32,
    pub disk_total_gb: f32,
}

/// Bucketed averages over a time range for charting (downsamples long ranges so
/// the payload stays small regardless of sample density).
pub async fn query_agent_metrics(
    pool: &PgPool,
    agent_id: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    bucket_secs: i64,
) -> Result<Vec<MetricsBucket>> {
    let bucket = bucket_secs.max(1);
    // `$4::bigint` keeps the bucket an int8 parameter, as the runtime bind declared it.
    let rows = sqlx::query!(
        "SELECT
           (floor(extract(epoch from ts) / $4::bigint) * $4::bigint)::bigint AS t,
           avg(cpu_pct)::real       AS cpu_pct,
           avg(mem_pct)::real       AS mem_pct,
           max(mem_used_mb)         AS mem_used_mb,
           max(mem_total_mb)        AS mem_total_mb,
           avg(disk_pct)::real      AS disk_pct,
           max(disk_used_gb)::real  AS disk_used_gb,
           max(disk_total_gb)::real AS disk_total_gb
         FROM agent_metrics
         WHERE agent_id = $1 AND ts >= $2 AND ts <= $3
         GROUP BY t
         ORDER BY t",
        agent_id,
        from,
        to,
        bucket,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| MetricsBucket {
            t: r.t.unwrap_or(0),
            cpu_pct: r.cpu_pct.unwrap_or(0.0),
            mem_pct: r.mem_pct.unwrap_or(0.0),
            mem_used_mb: r.mem_used_mb.unwrap_or(0),
            mem_total_mb: r.mem_total_mb.unwrap_or(0),
            disk_pct: r.disk_pct.unwrap_or(0.0),
            disk_used_gb: r.disk_used_gb.unwrap_or(0.0),
            disk_total_gb: r.disk_total_gb.unwrap_or(0.0),
        })
        .collect())
}

/// Delete stale resource samples (by `ts`).
pub async fn prune_metrics_by_age(pool: &PgPool, days: i64) -> Result<u64> {
    let r = sqlx::query!(
        "DELETE FROM agent_metrics WHERE ts < NOW() - ($1::bigint * INTERVAL '1 day')",
        days,
    )
    .execute(pool)
    .await?;
    Ok(r.rows_affected())
}
