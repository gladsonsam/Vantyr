//! Database storage accounting: total size plus per-table bytes, with partitioned
//! Recall tables charged to their parent.

use anyhow::Result;
use serde::Serialize;
use sqlx::PgPool;

/// `GET /api/settings/storage` body: database bytes split into public tables and the rest.
#[derive(Debug, Serialize)]
pub struct StorageReport {
    pub database_bytes: i64,
    pub public_tables_bytes: i64,
    pub other_bytes: i64,
    pub tables: Vec<TableStorage>,
}

/// One logical public relation (partitioned parents include their descendants).
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct TableStorage {
    pub name: String,
    pub bytes: i64,
}

/// PostgreSQL database bytes plus logical public-table storage. A partitioned
/// parent has no heap: explicitly sum its descendants (including indexes/TOAST)
/// instead of attributing retained Recall partitions to "other". Not blob usage.
pub async fn query_database_storage(pool: &PgPool) -> Result<StorageReport> {
    let db_size_bytes: i64 =
        sqlx::query_scalar!(r#"SELECT pg_database_size(current_database())::bigint AS "size!""#)
            .fetch_one(pool)
            .await?;
    let tables = query_relation_storage(pool, "public").await?;
    storage_report(db_size_bytes, tables)
}

// Namespace is bound, not interpolated. Tests query only their temporary schema;
// production requests public non-partition relations. Walk only declarative
// partition children (one parent); ordinary inheritance tables remain separate
// entries, so a multiply inherited child is never charged to several parents.
async fn query_relation_storage(pool: &PgPool, schema: &str) -> Result<Vec<TableStorage>> {
    Ok(sqlx::query_as!(
        TableStorage,
        r#"
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
        SELECT root.relname::text AS "name!",
               SUM(pg_total_relation_size(tree.relation_oid))::bigint AS "bytes!"
        FROM storage_tree tree JOIN pg_class root ON root.oid = tree.root_oid
        GROUP BY root.oid, root.relname ORDER BY "bytes!" DESC, "name!" ASC
    "#,
        schema,
    )
    .fetch_all(pool)
    .await?)
}

fn storage_report(db_size_bytes: i64, tables: Vec<TableStorage>) -> Result<StorageReport> {
    let public_tables_bytes = tables.iter().try_fold(0_i64, |sum, table| {
        anyhow::ensure!(table.bytes >= 0, "invalid storage size");
        sum.checked_add(table.bytes)
            .ok_or_else(|| anyhow::anyhow!("storage size overflow"))
    })?;
    let other_bytes = db_size_bytes.saturating_sub(public_tables_bytes).max(0);
    Ok(StorageReport {
        database_bytes: db_size_bytes,
        public_tables_bytes,
        other_bytes,
        tables,
    })
}

// ─── Analytics queries (URL sessions) ────────────────────────────────────────

#[cfg(test)]
mod tests;
