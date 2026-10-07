//! Database operations.
//!
//! All queries use the non-macro `sqlx::query()` / `sqlx::query_scalar()` API
//! so the server compiles without a running database (no `SQLX_OFFLINE` flag
//! needed in CI or Docker builds).

// Re-exported (`pub(crate)`) so the `db/` submodules can pull the whole shared prelude with a
// single `use super::*;`.
pub(crate) use chrono::{DateTime, TimeZone, Utc};

// Submodules carved out of the original monolithic `db.rs`. Each is `pub use`d so existing
// `db::<fn>` call sites keep working unchanged (facade pattern).

// ─── Utility ──────────────────────────────────────────────────────────────────

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
