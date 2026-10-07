//! Category lookups for one URL: admin overrides first, then the UT1 domain and URL lists.
//! Each returns `(category_id, key)` of an enabled category.

use anyhow::Result;
use sqlx::PgPool;

/// Enabled category of a domain override matching any of `suffixes`.
pub async fn override_domain_match(
    pool: &PgPool,
    suffixes: &[String],
) -> Result<Option<(i64, String)>> {
    let row = sqlx::query!(
        r"
        SELECT o.category_id, c.key
        FROM url_category_overrides_domain o
        JOIN url_categories c ON c.id = o.category_id
        WHERE c.enabled = true
          AND o.domain = ANY($1)
        LIMIT 1
        ",
        suffixes
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| (r.category_id, r.key)))
}

/// Enabled category of a URL-prefix override matching `url_norm`.
pub async fn override_url_match(pool: &PgPool, url_norm: &str) -> Result<Option<(i64, String)>> {
    let row = sqlx::query!(
        r"
        SELECT o.category_id, c.key
        FROM url_category_overrides_url o
        JOIN url_categories c ON c.id = o.category_id
        WHERE c.enabled = true
          AND $1 LIKE (o.url_prefix || '%')
        LIMIT 1
        ",
        url_norm
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| (r.category_id, r.key)))
}

/// Enabled UT1 category whose domain list contains any of `suffixes`.
pub async fn domain_entry_match(
    pool: &PgPool,
    suffixes: &[String],
) -> Result<Option<(i64, String)>> {
    let row = sqlx::query!(
        r"
        SELECT e.category_id, c.key
        FROM url_category_domain_entries e
        JOIN url_categories c ON c.id = e.category_id
        WHERE c.enabled = true
          AND e.domain = ANY($1)
        LIMIT 1
        ",
        suffixes
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| (r.category_id, r.key)))
}

/// Enabled UT1 category whose URL list has a prefix of `url_norm`.
pub async fn url_entry_match(pool: &PgPool, url_norm: &str) -> Result<Option<(i64, String)>> {
    let row = sqlx::query!(
        r"
        SELECT e.category_id, c.key
        FROM url_category_url_entries e
        JOIN url_categories c ON c.id = e.category_id
        WHERE c.enabled = true
          AND $1 LIKE (e.url_prefix || '%')
        LIMIT 1
        ",
        url_norm
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| (r.category_id, r.key)))
}
