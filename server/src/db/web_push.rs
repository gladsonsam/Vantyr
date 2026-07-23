//! Web Push (browser) subscription persistence for PWA notifications.
//!
//! Rows are created by `POST /api/push/subscribe` (upsert keyed on the unique
//! `endpoint`) and consumed by the `web_push` notifier, which loads every
//! subscription on an alert match and prunes the ones the push service reports
//! as gone (HTTP 404/410).

use super::*;

/// One browser push subscription (only the fields the notifier needs to send).
#[derive(Debug, Clone)]
pub struct WebPushSubscription {
    pub id: i64,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

/// Upsert a subscription for a user. `endpoint` is unique, so re-subscribing the
/// same browser (possibly under a different user) refreshes the keys and clears
/// any accumulated failures.
pub async fn upsert_web_push_subscription(
    pool: &PgPool,
    user_id: Uuid,
    endpoint: &str,
    p256dh: &str,
    auth: &str,
    user_agent: Option<&str>,
) -> Result<()> {
    sqlx::query(
        r"
        INSERT INTO web_push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (endpoint) DO UPDATE SET
            user_id       = EXCLUDED.user_id,
            p256dh        = EXCLUDED.p256dh,
            auth          = EXCLUDED.auth,
            user_agent    = EXCLUDED.user_agent,
            failure_count = 0
        ",
    )
    .bind(user_id)
    .bind(endpoint)
    .bind(p256dh)
    .bind(auth)
    .bind(user_agent)
    .execute(pool)
    .await?;
    Ok(())
}

/// Delete a subscription by its endpoint (scoped to the requesting user so one
/// user can't unsubscribe another's device). Returns the number of rows removed.
pub async fn delete_web_push_subscription(
    pool: &PgPool,
    user_id: Uuid,
    endpoint: &str,
) -> Result<u64> {
    let res = sqlx::query("DELETE FROM web_push_subscriptions WHERE user_id = $1 AND endpoint = $2")
        .bind(user_id)
        .bind(endpoint)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// Every subscription across all users — the notifier fans an alert out to all of
/// them (alert notifications are server-global, matching the other providers).
pub async fn all_web_push_subscriptions(pool: &PgPool) -> Result<Vec<WebPushSubscription>> {
    let rows = sqlx::query("SELECT id, endpoint, p256dh, auth FROM web_push_subscriptions")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| WebPushSubscription {
            id: r.get("id"),
            endpoint: r.get("endpoint"),
            p256dh: r.get("p256dh"),
            auth: r.get("auth"),
        })
        .collect())
}

/// Remove a dead subscription the push service reported as gone (404/410).
pub async fn prune_web_push_subscription(pool: &PgPool, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM web_push_subscriptions WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Mark a successful delivery (resets the failure counter).
pub async fn mark_web_push_success(pool: &PgPool, id: i64) -> Result<()> {
    sqlx::query(
        "UPDATE web_push_subscriptions SET last_success_at = now(), failure_count = 0 WHERE id = $1",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Increment the failure counter for a transient send error (kept for visibility;
/// only 404/410 prune outright).
pub async fn mark_web_push_failure(pool: &PgPool, id: i64) -> Result<()> {
    sqlx::query("UPDATE web_push_subscriptions SET failure_count = failure_count + 1 WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
