//! UT1 categories: listing, enabling and labelling them.

use anyhow::Result;
use serde::Serialize;
use sqlx::PgPool;

#[derive(Serialize)]
pub struct CategoryRow {
    pub key: String,
    pub label: String,
    pub enabled: bool,
    pub description: String,
}

pub async fn list_categories(pool: &PgPool) -> Result<Vec<CategoryRow>> {
    let rows = sqlx::query!(
        r"
        SELECT c.key,
               c.enabled,
               COALESCE(l.description_en, c.description, '') AS description,
               COALESCE(l.label_en, initcap(replace(replace(c.key, '_', ' '), '-', ' '))) AS label
        FROM url_categories c
        LEFT JOIN url_category_labels l ON l.key = c.key
        ORDER BY c.key ASC
        "
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let label = r.label.unwrap_or_else(|| r.key.clone());
            CategoryRow {
                key: r.key,
                label,
                enabled: r.enabled,
                description: r.description.unwrap_or_default(),
            }
        })
        .collect())
}

/// One category toggle; `label` (already trimmed, non-empty) also upserts the display label.
pub struct CategoryUpdate<'a> {
    pub key: &'a str,
    pub enabled: bool,
    pub label: Option<&'a str>,
    pub description: &'a str,
}

pub async fn set_categories(pool: &PgPool, updates: &[CategoryUpdate<'_>]) -> Result<()> {
    let mut tx = pool.begin().await?;
    for c in updates {
        sqlx::query!(
            "UPDATE url_categories SET enabled = $1 WHERE key = $2",
            c.enabled,
            c.key
        )
        .execute(&mut *tx)
        .await?;
        if let Some(label) = c.label {
            sqlx::query!(
                r"
                INSERT INTO url_category_labels (key, label_en, description_en, updated_at)
                VALUES ($1, $2, $3, NOW())
                ON CONFLICT (key) DO UPDATE
                    SET label_en = EXCLUDED.label_en,
                        description_en = EXCLUDED.description_en,
                        updated_at = NOW()
                ",
                c.key,
                label,
                c.description
            )
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

pub async fn category_id_by_key(pool: &PgPool, key: &str) -> Result<Option<i64>> {
    Ok(
        sqlx::query_scalar!("SELECT id FROM url_categories WHERE key = $1", key)
            .fetch_optional(pool)
            .await?,
    )
}
