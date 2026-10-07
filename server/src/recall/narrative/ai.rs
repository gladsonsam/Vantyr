//! Optional OpenAI-compatible vision narrative.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use chrono::{DateTime, Utc};
use tracing::info;

use super::db::{self, SegmentInput};
use crate::config::ScreenHistoryAi;
use crate::state::AppState;

/// Max keyframes attached to the AI vision call.
const AI_MAX_IMAGES: usize = 4;

/// Optional OpenAI-compatible vision narrative. Errors bubble up so the caller can
/// fall back to rule-based text.
pub(super) async fn ai_narrative(
    state: &Arc<AppState>,
    cfg: &ScreenHistoryAi,
    agent_id: uuid::Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    segs: &[SegmentInput],
    tz: chrono_tz::Tz,
) -> anyhow::Result<String> {
    // Build a compact text digest of the day's segments. Times are rendered in the
    // agent's local zone — a narrative that says "worked late into the evening" has
    // to be reading the same clock the person was.
    let mut digest = String::new();
    for s in segs.iter().take(60) {
        digest.push_str(&format!(
            "- {}–{} [{}] {}\n",
            s.start_ts.with_timezone(&tz).format("%H:%M"),
            s.end_ts.with_timezone(&tz).format("%H:%M"),
            s.category,
            s.summary.as_deref().unwrap_or(""),
        ));
    }

    // Sample a few frames and attach them as image parts (vision).
    let samples = db::sample_frames_for_range(&state.db, agent_id, from, to, AI_MAX_IMAGES as i64)
        .await
        .unwrap_or_default();
    let mut content: Vec<serde_json::Value> = vec![serde_json::json!({
        "type": "text",
        "text": format!(
            "You are summarizing a person's workday from screen activity. Write a concise \
             3–5 sentence narrative of what they worked on and whether they stayed focused. \
             Be specific and neutral. Activity timeline:\n{digest}"
        ),
    })];
    for (blob_ref, _ocr) in samples.iter().take(AI_MAX_IMAGES) {
        let path = state.settings.screen_history_dir.join(blob_ref);
        if let Ok(bytes) = tokio::fs::read(&path).await {
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            content.push(serde_json::json!({
                "type": "image_url",
                "image_url": { "url": format!("data:image/jpeg;base64,{b64}") },
            }));
        }
    }

    let body = serde_json::json!({
        "model": cfg.model,
        "max_tokens": 400,
        "messages": [ { "role": "user", "content": content } ],
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()?;
    let mut req = client
        .post(format!("{}/chat/completions", cfg.base_url))
        .json(&body);
    if let Some(key) = &cfg.api_key {
        req = req.bearer_auth(key);
    }
    let resp = req.send().await?;
    let status = resp.status();
    let val: serde_json::Value = resp.json().await?;
    if !status.is_success() {
        anyhow::bail!("AI provider returned {status}: {}", val);
    }
    let text = val["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        anyhow::bail!("AI provider returned empty content");
    }
    info!(%agent_id, "screen-narrative: AI narrative generated");
    Ok(text)
}
