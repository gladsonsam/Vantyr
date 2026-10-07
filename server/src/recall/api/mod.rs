//! Screen-history ("Recall") REST endpoints: frame-range (timelapse/scrub), the
//! frame nearest a timestamp, and the JPEG blob for one frame.
//!
//! All endpoints are operator-gated for now. Phase 4 will add agent→user ownership
//! so self-review users can see only their own machine.

use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

use crate::http::AuthUser;
use crate::state::AppState;

use crate::platform::audit;

pub(super) mod blob;
mod cursor;
pub(super) mod handlers;
pub(super) mod settings;

// ── Audit actions ─────────────────────────────────────────────────────────────
//
// Replaying someone's screen history is the most privacy-sensitive capability in
// the product, so every distinct kind of access is recorded against the operator
// who performed it. Volume-heavy actions (frame listing, blob fetches) are
// throttled to one row per viewing window by `should_audit_recall_access`;
// searches are always logged individually because the *query text* is the part an
// investigation actually needs.

/// Timeline replay: listing frames, scrubbing, or fetching keyframe images.
pub(super) const AUDIT_REPLAY: &str = "recall_replay";
/// OCR full-text search over an agent's captured screens.
pub(super) const AUDIT_SEARCH: &str = "recall_search";
/// Reading the derived day narrative / activity segments.
pub(super) const AUDIT_DAY_VIEW: &str = "recall_day_view";

/// Record a Recall access, collapsing continuous viewing into one row per window.
pub(super) async fn audit_recall(
    s: &Arc<AppState>,
    user: &AuthUser,
    agent_id: Uuid,
    action: &'static str,
    ip: Option<&str>,
) {
    if !s
        .throttles
        .should_audit_recall_access(user.user_id, agent_id, action)
    {
        return;
    }
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(agent_id),
        action,
        "ok",
        &serde_json::json!({ "role": user.role }),
        ip,
    )
    .await;
}

/// Hard cap on frames returned in one range query (keeps the scrubber payload bounded).
pub(super) const MAX_FRAMES: i64 = 5_000;

pub(super) fn parse_range(
    from: Option<String>,
    to: Option<String>,
) -> Result<(DateTime<Utc>, DateTime<Utc>), &'static str> {
    let now = Utc::now();
    let end = match to {
        None => now,
        Some(s) => DateTime::parse_from_rfc3339(s.trim())
            .map_err(|_| "invalid 'to' (expected RFC3339)")?
            .with_timezone(&Utc),
    };
    let start = match from {
        None => end - Duration::days(1),
        Some(s) => DateTime::parse_from_rfc3339(s.trim())
            .map_err(|_| "invalid 'from' (expected RFC3339)")?
            .with_timezone(&Utc),
    };
    if start > end {
        return Err("'from' must be <= 'to'");
    }
    Ok((start, end))
}
