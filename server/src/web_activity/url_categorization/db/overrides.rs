//! Admin domain and URL-prefix overrides.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;

#[derive(Serialize)]
pub struct OverrideRow {
    pub id: i64,
    pub kind: String,
    pub value: String,
    pub category_key: String,
    pub category_label: String,
    pub note: String,
    pub created_at: DateTime<Utc>,
}

/// Domain overrides then URL-prefix overrides, each newest first and paged independently.
pub async fn list_overrides(
    pool: &PgPool,
    query: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<OverrideRow>> {
    let domain_rows = sqlx::query!(
        r"
        SELECT o.id, 'domain' AS kind, o.domain AS value, c.key AS category_key,
               COALESCE(l.label_en, initcap(replace(replace(c.key, '_', ' '), '-', ' '))) AS category_label, o.note, o.created_at
        FROM url_category_overrides_domain o
        JOIN url_categories c ON c.id = o.category_id
        LEFT JOIN url_category_labels l ON l.key = c.key
        WHERE ($1 = '' OR o.domain ILIKE ('%' || $1 || '%') OR c.key ILIKE ('%' || $1 || '%'))
        ORDER BY o.created_at DESC
        LIMIT $2 OFFSET $3
        ",
        query,
        limit,
        offset
    )
    .fetch_all(pool)
    .await;

    let url_rows = sqlx::query!(
        r"
        SELECT o.id, 'url' AS kind, o.url_prefix AS value, c.key AS category_key,
               COALESCE(l.label_en, initcap(replace(replace(c.key, '_', ' '), '-', ' '))) AS category_label, o.note, o.created_at
        FROM url_category_overrides_url o
        JOIN url_categories c ON c.id = o.category_id
        LEFT JOIN url_category_labels l ON l.key = c.key
        WHERE ($1 = '' OR o.url_prefix ILIKE ('%' || $1 || '%') OR c.key ILIKE ('%' || $1 || '%'))
        ORDER BY o.created_at DESC
        LIMIT $2 OFFSET $3
        ",
        query,
        limit,
        offset
    )
    .fetch_all(pool)
    .await;

    let (d, u) = match (domain_rows, url_rows) {
        (Ok(d), Ok(u)) => (d, u),
        (Err(e), _) | (_, Err(e)) => return Err(e.into()),
    };
    let domain = d.into_iter().map(|r| OverrideRow {
        id: r.id,
        kind: r.kind.unwrap_or_else(|| "domain".into()),
        value: r.value,
        category_key: r.category_key,
        category_label: r.category_label.unwrap_or_default(),
        note: r.note,
        created_at: r.created_at,
    });
    let url = u.into_iter().map(|r| OverrideRow {
        id: r.id,
        kind: r.kind.unwrap_or_else(|| "domain".into()),
        value: r.value,
        category_key: r.category_key,
        category_label: r.category_label.unwrap_or_default(),
        note: r.note,
        created_at: r.created_at,
    });
    Ok(domain.chain(url).collect())
}

pub enum OverrideTarget {
    Domain(String),
    UrlPrefix(String),
}

/// Distinguishes the override upsert failing (e.g. a lock timeout) from the surrounding
/// transaction plumbing failing.
pub enum OverrideWriteError {
    Insert(sqlx::Error),
    Tx(sqlx::Error),
}

/// Upsert a domain or URL-prefix override with short lock/statement timeouts so the admin
/// UI doesn't hang if another transaction holds locks on the overrides tables.
pub async fn upsert_override(
    pool: &PgPool,
    category_id: i64,
    target: &OverrideTarget,
    note: &str,
) -> std::result::Result<(), OverrideWriteError> {
    let mut tx = pool.begin().await.map_err(OverrideWriteError::Tx)?;
    sqlx::query!("SET LOCAL lock_timeout = '1s'")
        .execute(&mut *tx)
        .await
        .map_err(OverrideWriteError::Tx)?;
    sqlx::query!("SET LOCAL statement_timeout = '5s'")
        .execute(&mut *tx)
        .await
        .map_err(OverrideWriteError::Tx)?;

    let res = match target {
        OverrideTarget::Domain(domain) => sqlx::query!(
            r"INSERT INTO url_category_overrides_domain (category_id, domain, note)
               VALUES ($1,$2,$3)
               ON CONFLICT (domain) DO UPDATE SET category_id = EXCLUDED.category_id, note = EXCLUDED.note
            ",
            category_id,
            domain,
            note
        )
        .execute(&mut *tx)
        .await,
        OverrideTarget::UrlPrefix(url_prefix) => sqlx::query!(
            r"INSERT INTO url_category_overrides_url (category_id, url_prefix, note)
               VALUES ($1,$2,$3)
               ON CONFLICT (url_prefix) DO UPDATE SET category_id = EXCLUDED.category_id, note = EXCLUDED.note
            ",
            category_id,
            url_prefix,
            note
        )
        .execute(&mut *tx)
        .await,
    };
    if let Err(e) = res {
        let _ = tx.rollback().await;
        return Err(OverrideWriteError::Insert(e));
    }
    tx.commit().await.map_err(OverrideWriteError::Tx)?;
    Ok(())
}

pub async fn delete_domain_override(pool: &PgPool, id: i64) -> Result<u64> {
    let r = sqlx::query!(
        "DELETE FROM url_category_overrides_domain WHERE id = $1",
        id
    )
    .execute(pool)
    .await?;
    Ok(r.rows_affected())
}

pub async fn delete_url_override(pool: &PgPool, id: i64) -> Result<u64> {
    let r = sqlx::query!("DELETE FROM url_category_overrides_url WHERE id = $1", id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected())
}
