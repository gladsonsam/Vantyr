//! UT1 list releases: importing a downloaded release and the admin status counts.

use std::collections::HashMap;

use anyhow::Result;
use sqlx::PgPool;

/// Record a new (inactive) release row; [`activate_release`] makes it the active one.
pub async fn insert_release(pool: &PgPool, sha256: &str) -> Result<i64> {
    let release_id: i64 = sqlx::query_scalar!(
        r"
        INSERT INTO url_categorization_release (version, sha256, active)
        VALUES ($1, $2, false)
        RETURNING id
        ",
        "sha256",
        sha256
    )
    .fetch_one(pool)
    .await?;
    Ok(release_id)
}

/// Replace every list entry with the parsed release (`category_key -> domains / url prefixes`)
/// and make `release_id` the single active release, atomically.
pub async fn activate_release(
    pool: &PgPool,
    release_id: i64,
    cat_domains: HashMap<String, Vec<String>>,
    cat_urls: HashMap<String, Vec<String>>,
) -> Result<()> {
    // Transaction: wipe existing entries, upsert categories, insert entries, activate new release (single active).
    let mut tx = pool.begin().await?;

    // Clear old active release + entries.
    sqlx::query!("UPDATE url_categorization_release SET active = false WHERE active = true")
        .execute(&mut *tx)
        .await?;
    sqlx::query!("DELETE FROM url_category_domain_entries")
        .execute(&mut *tx)
        .await?;
    sqlx::query!("DELETE FROM url_category_url_entries")
        .execute(&mut *tx)
        .await?;

    // Ensure categories exist and build key->id map.
    let mut cat_id: HashMap<String, i64> = HashMap::new();
    for key in cat_domains.keys().chain(cat_urls.keys()) {
        let id: i64 = sqlx::query_scalar!(
            r"
            INSERT INTO url_categories (key, enabled)
            VALUES ($1, true)
            ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
            RETURNING id
            ",
            key
        )
        .fetch_one(&mut *tx)
        .await?;
        cat_id.insert(key.clone(), id);
    }

    // Bulk insert entries (chunked).
    for (key, domains) in cat_domains {
        let Some(&id) = cat_id.get(&key) else {
            continue;
        };
        // Smaller chunks reduce statement size and avoid slow-query log spam on some setups.
        for chunk in domains.chunks(2_000) {
            let mut qb = sqlx::QueryBuilder::new(
                "INSERT INTO url_category_domain_entries (category_id, domain) ",
            );
            qb.push_values(chunk, |mut b, d| {
                b.push_bind(id).push_bind(d);
            });
            qb.push(" ON CONFLICT DO NOTHING");
            qb.build().execute(&mut *tx).await?;
        }
    }
    for (key, prefixes) in cat_urls {
        let Some(&id) = cat_id.get(&key) else {
            continue;
        };
        for chunk in prefixes.chunks(2_000) {
            let mut qb = sqlx::QueryBuilder::new(
                "INSERT INTO url_category_url_entries (category_id, url_prefix) ",
            );
            qb.push_values(chunk, |mut b, p| {
                b.push_bind(id).push_bind(p);
            });
            qb.push(" ON CONFLICT DO NOTHING");
            qb.build().execute(&mut *tx).await?;
        }
    }

    sqlx::query!(
        "UPDATE url_categorization_release SET active = true WHERE id = $1",
        release_id
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

pub async fn active_release_sha(pool: &PgPool) -> Result<Option<String>> {
    Ok(sqlx::query_scalar!(
        "SELECT sha256 FROM url_categorization_release WHERE active = true ORDER BY id DESC LIMIT 1"
    )
    .fetch_optional(pool)
    .await?)
}

pub async fn count_categories(pool: &PgPool) -> Result<i64> {
    Ok(
        sqlx::query_scalar!(r#"SELECT COUNT(*)::bigint AS "count!" FROM url_categories"#)
            .fetch_one(pool)
            .await?,
    )
}

pub async fn count_domain_entries(pool: &PgPool) -> Result<i64> {
    Ok(sqlx::query_scalar!(
        r#"SELECT COUNT(*)::bigint AS "count!" FROM url_category_domain_entries"#
    )
    .fetch_one(pool)
    .await?)
}

pub async fn count_url_entries(pool: &PgPool) -> Result<i64> {
    Ok(
        sqlx::query_scalar!(r#"SELECT COUNT(*)::bigint AS "count!" FROM url_category_url_entries"#)
            .fetch_one(pool)
            .await?,
    )
}
