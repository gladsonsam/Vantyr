//! Custom rollup categories and their UT1 members.

use std::collections::HashMap;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;

#[derive(Serialize)]
pub struct CustomCategoryRow {
    pub id: i64,
    pub key: String,
    pub label_en: String,
    pub description_en: String,
    pub display_order: i32,
    pub hidden: bool,
    pub updated_at: DateTime<Utc>,
    pub member_count: i64,
    pub ut1_keys: Vec<String>,
}

pub async fn list_custom_categories(pool: &PgPool) -> Result<Vec<CustomCategoryRow>> {
    let cats = sqlx::query!(
        r"
        SELECT c.id, c.key, c.label_en, c.description_en, c.display_order, c.hidden, c.updated_at,
               COALESCE(m.member_count, 0)::bigint AS member_count
        FROM url_custom_categories c
        LEFT JOIN (
            SELECT custom_category_id, COUNT(*)::bigint AS member_count
            FROM url_custom_category_members
            GROUP BY custom_category_id
        ) m ON m.custom_category_id = c.id
        ORDER BY c.display_order ASC, c.label_en ASC, c.id ASC
        "
    )
    .fetch_all(pool)
    .await;

    let members = sqlx::query!(
        r"
        SELECT m.custom_category_id, m.ut1_key
        FROM url_custom_category_members m
        ORDER BY m.custom_category_id ASC, m.ut1_key ASC
        "
    )
    .fetch_all(pool)
    .await;

    let (cats, members) = match (cats, members) {
        (Ok(cats), Ok(members)) => (cats, members),
        (Err(e), _) | (_, Err(e)) => return Err(e.into()),
    };
    let mut by_id: HashMap<i64, Vec<String>> = HashMap::new();
    for r in members {
        by_id
            .entry(r.custom_category_id)
            .or_default()
            .push(r.ut1_key);
    }
    Ok(cats
        .into_iter()
        .map(|r| CustomCategoryRow {
            id: r.id,
            key: r.key,
            label_en: r.label_en,
            description_en: r.description_en,
            display_order: r.display_order,
            hidden: r.hidden,
            updated_at: r.updated_at,
            member_count: r.member_count.unwrap_or(0),
            ut1_keys: by_id.get(&r.id).cloned().unwrap_or_default(),
        })
        .collect())
}

pub async fn create_custom_category(
    pool: &PgPool,
    key: &str,
    label_en: &str,
    description_en: &str,
    display_order: i32,
    hidden: bool,
) -> Result<i64> {
    let r = sqlx::query!(
        r"
        INSERT INTO url_custom_categories (key, label_en, description_en, display_order, hidden, updated_at)
        VALUES ($1,$2,$3,$4,$5,NOW())
        RETURNING id
        ",
        key,
        label_en,
        description_en,
        display_order,
        hidden
    )
    .fetch_one(pool)
    .await?;
    Ok(r.id)
}

pub struct CustomCategory {
    pub key: String,
    pub label_en: String,
    pub description_en: String,
    pub display_order: i32,
    pub hidden: bool,
}

pub async fn get_custom_category(pool: &PgPool, id: i64) -> Result<Option<CustomCategory>> {
    let cur = sqlx::query!(
        "SELECT id, key, label_en, description_en, display_order, hidden FROM url_custom_categories WHERE id = $1",
        id
    )
        .fetch_optional(pool)
        .await?;
    Ok(cur.map(|cur| CustomCategory {
        key: cur.key,
        label_en: cur.label_en,
        description_en: cur.description_en,
        display_order: cur.display_order,
        hidden: cur.hidden,
    }))
}

pub async fn update_custom_category(
    pool: &PgPool,
    id: i64,
    label_en: &str,
    description_en: &str,
    display_order: i32,
    hidden: bool,
) -> Result<u64> {
    let r = sqlx::query!(
        r"
        UPDATE url_custom_categories
        SET label_en = $2,
            description_en = $3,
            display_order = $4,
            hidden = $5,
            updated_at = NOW()
        WHERE id = $1
        ",
        id,
        label_en,
        description_en,
        display_order,
        hidden
    )
    .execute(pool)
    .await?;
    Ok(r.rows_affected())
}

pub async fn custom_category_exists(pool: &PgPool, id: i64) -> Result<bool> {
    let exists: Option<i64> =
        sqlx::query_scalar!("SELECT id FROM url_custom_categories WHERE id = $1", id)
            .fetch_optional(pool)
            .await?;
    Ok(exists.is_some())
}

/// Up to 25 of `keys` that are not known UT1 category keys.
pub async fn unknown_ut1_keys(pool: &PgPool, keys: &[String]) -> Result<Vec<String>> {
    let missing = sqlx::query_scalar!(
        r"
        SELECT k AS missing
        FROM UNNEST($1::text[]) AS k
        WHERE NOT EXISTS (SELECT 1 FROM url_categories c WHERE c.key = k)
        LIMIT 25
        ",
        keys
    )
    .fetch_all(pool)
    .await?;
    Ok(missing.into_iter().map(Option::unwrap_or_default).collect())
}

pub async fn replace_custom_category_members(
    pool: &PgPool,
    id: i64,
    keys: &[String],
) -> Result<()> {
    let mut tx = pool.begin().await?;
    if let Err(e) = sqlx::query!(
        "DELETE FROM url_custom_category_members WHERE custom_category_id = $1",
        id
    )
    .execute(&mut *tx)
    .await
    {
        let _ = tx.rollback().await;
        return Err(e.into());
    }
    for k in keys {
        if let Err(e) = sqlx::query!(
            "INSERT INTO url_custom_category_members (custom_category_id, ut1_key) VALUES ($1,$2) ON CONFLICT DO NOTHING",
            id,
            k
        )
        .execute(&mut *tx)
        .await
        {
            let _ = tx.rollback().await;
            return Err(e.into());
        }
    }
    tx.commit().await?;
    Ok(())
}

pub async fn delete_custom_category(pool: &PgPool, id: i64) -> Result<u64> {
    let r = sqlx::query!("DELETE FROM url_custom_categories WHERE id = $1", id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected())
}
