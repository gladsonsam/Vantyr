//! Recall capture settings: global defaults and per-agent overrides.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::ConnectInfo;
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::{RequireAdmin, RequireOperator};
use crate::recall::db;
use crate::state::AppState;

use crate::http::audit_ip;
use crate::platform::audit;

// ── Capture settings administration ───────────────────────────────────────────

/// Operator-supplied capture settings. Every field optional: omitted means "leave
/// as-is" globally, or "inherit the global value" for a per-agent override.
#[derive(Debug, Default, Deserialize, serde::Serialize)]
pub struct RecallSettingsBody {
    enabled: Option<bool>,
    interval_ms: Option<i32>,
    hot_interval_ms: Option<i32>,
    jpeg_quality: Option<i16>,
    max_dim: Option<i32>,
    dedup_hamming: Option<i16>,
    keyframe_max_gap_ms: Option<i32>,
    ocr: Option<bool>,
}

/// Validate ranges before hitting the DB, so an out-of-range value returns a useful
/// 400 rather than a 500 from a CHECK constraint violation.
fn validate_settings(b: &RecallSettingsBody) -> Result<db::RecallSettingsPatch, &'static str> {
    fn in_range<T: PartialOrd + Copy>(
        v: Option<T>,
        lo: T,
        hi: T,
        msg: &'static str,
    ) -> Result<Option<T>, &'static str> {
        match v {
            Some(x) if x < lo || x > hi => Err(msg),
            other => Ok(other),
        }
    }

    Ok(db::RecallSettingsPatch {
        enabled: b.enabled,
        interval_ms: in_range(
            b.interval_ms,
            1_000,
            3_600_000,
            "interval_ms must be 1000–3600000",
        )?,
        hot_interval_ms: in_range(
            b.hot_interval_ms,
            1_000,
            3_600_000,
            "hot_interval_ms must be 1000–3600000",
        )?,
        jpeg_quality: in_range(b.jpeg_quality, 1, 100, "jpeg_quality must be 1–100")?,
        // 0 is the documented "don't downscale" sentinel, so it bypasses the range.
        max_dim: match b.max_dim {
            Some(0) | None => b.max_dim,
            Some(x) if (320..=7680).contains(&x) => Some(x),
            Some(_) => return Err("max_dim must be 0 (no downscale) or 320–7680"),
        },
        dedup_hamming: in_range(b.dedup_hamming, 0, 64, "dedup_hamming must be 0–64")?,
        keyframe_max_gap_ms: in_range(
            b.keyframe_max_gap_ms,
            10_000,
            86_400_000,
            "keyframe_max_gap_ms must be 10000–86400000",
        )?,
        ocr: b.ocr,
    })
}

/// `GET /settings/recall` — global capture settings.
pub async fn recall_settings_get(
    State(s): State<Arc<AppState>>,
    RequireOperator(_user): RequireOperator,
) -> ApiResult<Json<db::RecallSettings>> {
    let v = db::get_recall_settings_global(&s.db).await?;
    Ok(Json(v))
}

/// `PUT /settings/recall` — change global capture settings (admin only).
///
/// Admin-gated: this controls how much every machine in the fleet records, and
/// includes the kill switch.
pub async fn recall_settings_put(
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<RecallSettingsBody>,
) -> ApiResult<Json<db::RecallSettings>> {
    let patch = validate_settings(&body).map_err(ApiError::bad_request)?;
    db::set_recall_settings_global(&s.db, &patch).await?;
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "recall_settings_global",
        "ok",
        &serde_json::to_value(&body).unwrap_or_else(|_| serde_json::json!({})),
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    crate::agent_ws::policy_push::push_recall_settings_to_all_connected(&s).await;
    recall_settings_get(State(s.clone()), RequireOperator(user)).await
}

/// `GET /agents/:id/history/settings` — what this agent runs with, and why.
///
/// Returns all three layers: `effective` (what the agent is actually told),
/// `override` (the per-agent row, `null` when there is none, with `null` fields for
/// the tunables it doesn't override) and `global` (the fleet default). A settings UI
/// needs the distinction — otherwise every inherited value looks like a deliberate
/// per-agent choice, and clearing one field is indistinguishable from setting it.
pub async fn agent_recall_settings_get(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    RequireOperator(_user): RequireOperator,
) -> ApiResult<Json<Value>> {
    let effective = db::effective_recall_settings(&s.db, id).await?;
    let overridden = db::get_recall_settings_agent_override(&s.db, id).await?;
    let global = db::get_recall_settings_global(&s.db).await?;
    Ok(Json(serde_json::json!({
        "effective": effective,
        "override": overridden,
        "global": global,
    })))
}

/// `PUT /agents/:id/history/settings` — per-agent override (admin only).
///
/// Omitted fields become NULL, i.e. that field inherits the global value again.
pub async fn agent_recall_settings_put(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<RecallSettingsBody>,
) -> ApiResult<Json<Value>> {
    let patch = validate_settings(&body).map_err(ApiError::bad_request)?;
    db::set_recall_settings_agent(&s.db, id, &patch).await?;
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        "recall_settings_agent",
        "ok",
        &serde_json::to_value(&body).unwrap_or_else(|_| serde_json::json!({})),
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    crate::agent_ws::policy_push::push_recall_settings_to_agent(&s, id).await;
    agent_recall_settings_get(Path(id), State(s.clone()), RequireOperator(user)).await
}

/// `DELETE /agents/:id/history/settings` — drop the override, inherit global again.
pub async fn agent_recall_settings_delete(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    db::clear_recall_settings_agent(&s.db, id).await?;
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        "recall_settings_agent_clear",
        "ok",
        &serde_json::json!({}),
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    crate::agent_ws::policy_push::push_recall_settings_to_agent(&s, id).await;
    Ok(Json(serde_json::json!({ "ok": true })))
}
