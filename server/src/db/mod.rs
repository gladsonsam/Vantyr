//! Database plumbing shared by every feature: the connection pool, embedded migrations,
//! and small row helpers. Feature queries live next to their feature (`<feature>/db.rs`).
//!
//! Static queries use the compile-time checked `sqlx::query!` family. Builds without a
//! database set `SQLX_OFFLINE=true` and read the committed `server/.sqlx` cache; regenerate
//! it with `cargo sqlx prepare` after changing a query (see `server/docs/database.md`).

use chrono::{DateTime, TimeZone, Utc};
use tracing::info;

use crate::config::ServerConfig;

/// Connect the pool and apply the migrations embedded from `server/migrations`.
pub async fn connect_and_migrate(cfg: &ServerConfig) -> anyhow::Result<sqlx::PgPool> {
    let db_url = cfg.database_url.clone();

    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(cfg.pool_max_connections)
        .connect(&db_url)
        .await
        .map_err(|e| anyhow::anyhow!("Database connection failed: {e}"))?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .map_err(|e| match e {
            sqlx::migrate::MigrateError::VersionMismatch(v) => anyhow::anyhow!(
                "Migration {v} checksum mismatch: the SQL embedded in this binary does not match `_sqlx_migrations` (common after editing an already-applied migration, or CRLF vs LF drift).\n\
                 \n\
                 Fix: rebuild the server from the repo, then sync checksums from the **same** `server/migrations` files used for that build:\n\
 cargo run --locked -p vantyr-server --bin migration_checksums\n\
                 Apply the printed UPDATEs with `psql` against this database, then restart.\n\
                 Inspect: SELECT version, encode(checksum,'hex') AS checksum_hex FROM _sqlx_migrations WHERE version = {v};\n\
                 \n\
                 (Docker builds now normalize `*.sql` to LF before compile.)\n\
                 \n\
                 Underlying error: {e}"
            ),
            sqlx::migrate::MigrateError::Dirty(v) => anyhow::anyhow!(
                "Migration {v} is dirty (partial apply). Check `_sqlx_migrations` for success = false. Resolve the failed migration SQL manually, then delete or fix that row before restarting.\n\
                 Underlying error: {e}"
            ),
            _ => anyhow::anyhow!("Migration failed: {e}"),
        })?;

    info!("Database ready.");
    Ok(pool)
}

/// Readiness probe: can the pool run a trivial query?
pub async fn ping(pool: &sqlx::PgPool) -> bool {
    // A bare `SELECT 1` is int4; the macro decodes it as such (an i64 decode would always fail).
    sqlx::query_scalar!("SELECT 1")
        .fetch_one(pool)
        .await
        .is_ok()
}

/// Postgres `unique_violation` (SQLSTATE 23505).
pub(crate) fn pg_is_unique_violation(e: &sqlx::Error) -> bool {
    match e {
        sqlx::Error::Database(db) => db.code().is_some_and(|c| c == "23505"),
        _ => false,
    }
}

pub(crate) fn unix_to_dt(ts: Option<i64>) -> DateTime<Utc> {
    ts.and_then(|s| Utc.timestamp_opt(s, 0).single())
        .unwrap_or_else(Utc::now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_violation_detection_is_conservative() {
        // A non-database error is never treated as a unique violation.
        assert!(!pg_is_unique_violation(&sqlx::Error::RowNotFound));
    }
}
