//! Retention: telemetry retention settings, and the background prune that applies them
//! together with the optional fixed-age limits for other features' tables.

use std::sync::Arc;

use anyhow::Result;
use axum::{routing::get, Router};
use sqlx::PgPool;

use crate::agents::telemetry::db as telemetry_db;
use crate::policy::alert_rules::db as alert_db;
use crate::scripts::scheduled::db as scheduled_db;
use crate::scripts::software_inventory::db as software_db;
use crate::state::AppState;

mod api;
pub mod db;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/agents/:id/retention",
            get(api::agent_retention_get)
                .put(api::agent_retention_put)
                .delete(api::agent_retention_delete),
        )
        .route(
            "/settings/retention",
            get(api::retention_global_get).put(api::retention_global_put),
        )
}

/// Optional extra pruning (alert history + old software rows + script executions).
/// Telemetry uses [`db::prune_telemetry_by_retention`].
pub async fn prune_auxiliary_retention(
    pool: &PgPool,
    alert_event_days: Option<i64>,
    software_inventory_days: Option<i64>,
    script_execution_days: Option<i64>,
    metrics_days: Option<i64>,
) -> Result<()> {
    if let Some(d) = alert_event_days {
        let n = alert_db::prune_alert_events_by_age(pool, d).await?;
        if n > 0 {
            tracing::info!(rows = n, "pruned old alert_rule_events by retention");
        }
    }
    if let Some(d) = software_inventory_days {
        let n = software_db::prune_agent_software_by_age(pool, d).await?;
        if n > 0 {
            tracing::info!(rows = n, "pruned old agent_software rows by retention");
        }
    }
    if let Some(d) = script_execution_days {
        let n = scheduled_db::executions::prune_script_executions_by_age(pool, d).await?;
        if n > 0 {
            tracing::info!(
                rows = n,
                "pruned old scheduled_script_executions by retention"
            );
        }
    }
    if let Some(d) = metrics_days {
        let n = telemetry_db::prune_metrics_by_age(pool, d).await?;
        if n > 0 {
            tracing::info!(rows = n, "pruned old agent_metrics by retention");
        }
    }
    Ok(())
}

/// Prune once at startup, then every `ret_secs`.
#[allow(clippy::too_many_arguments)]
pub fn spawn_prune_task(
    state_retention: Arc<AppState>,
    ret_secs: u64,
    alert_days: Option<i64>,
    software_days: Option<i64>,
    script_exec_days: Option<i64>,
    metrics_days: Option<i64>,
    screen_history_days: Option<i64>,
) {
    tokio::spawn(async move {
        let pool_retention = state_retention.db.clone();
        if let Err(e) = db::prune_telemetry_by_retention(&pool_retention).await {
            tracing::warn!(error = %e, "initial retention prune failed");
        }
        if let Err(e) = prune_auxiliary_retention(
            &pool_retention,
            alert_days,
            software_days,
            script_exec_days,
            metrics_days,
        )
        .await
        {
            tracing::warn!(error = %e, "initial auxiliary retention prune failed");
        }
        if let Some(d) = screen_history_days {
            if let Err(e) = crate::recall::retention::prune(state_retention.clone(), d).await {
                tracing::warn!(error = %e, "initial screen-history prune failed");
            }
        }
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(ret_secs));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if let Err(e) = db::prune_telemetry_by_retention(&pool_retention).await {
                tracing::warn!(error = %e, "retention prune failed");
            }
            if let Err(e) = prune_auxiliary_retention(
                &pool_retention,
                alert_days,
                software_days,
                script_exec_days,
                metrics_days,
            )
            .await
            {
                tracing::warn!(error = %e, "auxiliary retention prune failed");
            }
            if let Some(d) = screen_history_days {
                if let Err(e) = crate::recall::retention::prune(state_retention.clone(), d).await {
                    tracing::warn!(error = %e, "screen-history prune failed");
                }
            }
        }
    });
}
