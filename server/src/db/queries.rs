//! List / query / analytics helpers used by the API (carved out of the monolithic `db.rs`).

use super::*;

/// PostgreSQL database bytes plus logical public-table storage. A partitioned
/// parent has no heap: explicitly sum its descendants (including indexes/TOAST)
/// instead of attributing retained Recall partitions to "other". Not blob usage.
pub async fn query_database_storage(pool: &PgPool) -> Result<serde_json::Value> {
    let db_size_bytes: i64 =
        sqlx::query_scalar("SELECT pg_database_size(current_database())::bigint")
            .fetch_one(pool)
            .await?;
    let tables = query_relation_storage(pool, "public").await?;
    storage_report(db_size_bytes, tables)
}

// Namespace is bound, not interpolated. Tests query only their temporary schema;
// production requests public non-partition relations. Walk only declarative
// partition children (one parent); ordinary inheritance tables remain separate
// entries, so a multiply inherited child is never charged to several parents.
async fn query_relation_storage(pool: &PgPool, schema: &str) -> Result<Vec<serde_json::Value>> {
    let rows = sqlx::query(
        r"
        WITH RECURSIVE storage_tree(root_oid, relation_oid) AS (
            SELECT c.oid, c.oid FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'm')
              AND NOT c.relispartition
            UNION
            SELECT tree.root_oid, i.inhrelid FROM storage_tree tree
            JOIN pg_inherits i ON i.inhparent = tree.relation_oid
            JOIN pg_class child ON child.oid = i.inhrelid AND child.relispartition
        )
        SELECT root.relname::text AS name,
               SUM(pg_total_relation_size(tree.relation_oid))::bigint AS bytes
        FROM storage_tree tree JOIN pg_class root ON root.oid = tree.root_oid
        GROUP BY root.oid, root.relname ORDER BY bytes DESC, name ASC
    ",
    )
    .bind(schema)
    .fetch_all(pool)
    .await?;
    rows.iter()
        .map(|r| -> Result<serde_json::Value> {
            let name: String = r.try_get("name")?;
            let bytes: i64 = r.try_get("bytes")?;
            Ok(serde_json::json!({"name":name, "bytes":bytes}))
        })
        .collect()
}

fn storage_report(db_size_bytes: i64, tables: Vec<serde_json::Value>) -> Result<serde_json::Value> {
    let public_tables_bytes = tables.iter().try_fold(0_i64, |sum, table| {
        let bytes = table["bytes"]
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("invalid storage size"))?;
        anyhow::ensure!(bytes >= 0, "invalid storage size");
        sum.checked_add(bytes)
            .ok_or_else(|| anyhow::anyhow!("storage size overflow"))
    })?;
    let other_bytes = db_size_bytes.saturating_sub(public_tables_bytes).max(0);
    Ok(serde_json::json!({
        "database_bytes":db_size_bytes, "public_tables_bytes":public_tables_bytes,
        "other_bytes":other_bytes, "tables":tables,
    }))
}

// ─── Analytics queries (URL sessions) ────────────────────────────────────────

#[cfg(test)]
#[path = "storage_accounting_tests.rs"]
mod storage_accounting_tests;
