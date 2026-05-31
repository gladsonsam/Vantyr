//! URL / keystroke alert rules: load effective rules for an agent and broadcast matches to viewers.
//!
//! Rules are defined in Postgres with **scopes** (`all`, `group`, `agent`) so the same rule
//! definition can target every machine, a group, or one agent; multiple scopes per rule are allowed.

use std::sync::Arc;
use std::time::Instant;

use regex::RegexBuilder;
use uuid::Uuid;

use crate::db::{self, AlertRuleRow};
use crate::notify::AlertMatchPayload;
use crate::state::AppState;

fn haystack_for_channel(channel: &str, payload: &serde_json::Value) -> String {
    match channel {
        "url" => payload["url"].as_str().unwrap_or("").to_string(),
        "keys" => payload["text"].as_str().unwrap_or("").to_string(),
        "url_category" => payload["category_key"].as_str().unwrap_or("").to_string(),
        _ => String::new(),
    }
}

fn truncate_snippet(s: &str, channel: &str) -> String {
    let max_chars = if channel == "keys" { 48 } else { 120 };
    let t: String = s.chars().take(max_chars).collect();
    if s.chars().count() > max_chars {
        format!("{t}…")
    } else {
        t
    }
}

fn rule_matches(rule: &AlertRuleRow, haystack: &str) -> bool {
    if haystack.is_empty() {
        return false;
    }
    match rule.match_mode.as_str() {
        "regex" => {
            let Ok(re) = RegexBuilder::new(&rule.pattern)
                .case_insensitive(rule.case_insensitive)
                .build()
            else {
                return false;
            };
            re.is_match(haystack)
        }
        _ => {
            if rule.case_insensitive {
                let h = haystack.to_lowercase();
                let p = rule.pattern.to_lowercase();
                h.contains(&p)
            } else {
                haystack.contains(&rule.pattern)
            }
        }
    }
}

/// After telemetry is persisted, evaluate alert rules and notify dashboard viewers.
pub async fn on_url_or_keys_event(
    state: &Arc<AppState>,
    agent_id: Uuid,
    agent_name: &str,
    channel: &str,
    payload: &serde_json::Value,
) {
    if channel != "url" && channel != "keys" && channel != "url_category" {
        return;
    }

    let haystack = haystack_for_channel(channel, payload);
    if haystack.is_empty() {
        return;
    }

    let rules = match db::alert_rules_effective_for_agent(&state.db, agent_id, channel).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "alert_rules_effective_for_agent failed");
            return;
        }
    };

    for rule in rules {
        if !rule_matches(&rule, &haystack) {
            continue;
        }

        let cooldown = rule.cooldown_secs.max(0) as u64;
        if cooldown > 0 {
            let mut map = state.alert_match_cooldowns.lock();
            let key = (rule.id, agent_id);
            let now = Instant::now();
            if let Some(last) = map.get(&key) {
                if now.duration_since(*last).as_secs() < cooldown {
                    continue;
                }
            }
            map.insert(key, now);
        }

        let snippet = truncate_snippet(&haystack, channel);
        let event_id = match db::alert_rule_event_insert(
            &state.db,
            agent_id,
            rule.id,
            rule.name.as_str(),
            channel,
            snippet.as_str(),
        )
        .await
        {
            Ok(id) => id,
            Err(e) => {
                tracing::warn!(error = %e, "alert_rule_event_insert failed");
                continue;
            }
        };

        if rule.take_screenshot {
            // Fire-and-forget: request a one-off capture and store it against this event.
            let state2 = state.clone();
            tokio::spawn(async move {
                capture_and_store_screenshot_for_event(&state2, agent_id, event_id).await;
            });
        }
        let now = chrono::Utc::now();
        let ts = now.timestamp();
        state.broadcast(
            serde_json::json!({
                "event": "alert_rule_match",
                "rule_id": rule.id,
                "rule_name": rule.name,
                "channel": channel,
                "agent_id": agent_id,
                "agent_name": agent_name,
                "snippet": snippet,
                "ts": ts,
            })
            .to_string(),
        );

        let (dashboard_url, dashboard_activity_url) = match state.public_base_url.as_deref() {
            None => (None, None),
            Some(base) => {
                let agent_url = format!("{base}/agents/{agent_id}");
                let at_iso = now.to_rfc3339();
                let at = urlencoding::encode(at_iso.as_str());
                let activity_url = format!("{agent_url}?tab=activity&at={at}");
                (Some(agent_url), Some(activity_url))
            }
        };

        state.notify_hub.dispatch_alert_match(AlertMatchPayload {
            event_id,
            rule_id: rule.id,
            rule_name: rule.name.clone(),
            channel: channel.to_string(),
            agent_id,
            agent_name: agent_name.to_string(),
            snippet: snippet.clone(),
            ts,
            dashboard_url,
            dashboard_activity_url,
        });
    }
}

/// After URL categorization, evaluate category-based alert rules (channel: `url_category`).
pub async fn on_url_category_event(
    state: &Arc<AppState>,
    agent_id: Uuid,
    agent_name: &str,
    payload: &serde_json::Value,
) {
    on_url_or_keys_event(state, agent_id, agent_name, "url_category", payload).await;
}

async fn capture_and_store_screenshot_for_event(
    state: &Arc<AppState>,
    agent_id: Uuid,
    event_id: i64,
) {
    // Must have an active WS connection.
    if !state.agent_cmds.lock().contains_key(&agent_id) {
        return;
    }

    let prev_seq = state.frames.lock().get(&agent_id).map_or(0, |f| f.seq);
    let start = serde_json::json!({ "type": "start_capture" });
    if !state.try_send_agent_command_json(agent_id, &start) {
        return;
    }

    let mut jpeg: Option<bytes::Bytes> = None;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        {
            let frames = state.frames.lock();
            if let Some(f) = frames.get(&agent_id) {
                if f.seq > prev_seq && !f.jpeg.is_empty() {
                    jpeg = Some(f.jpeg.clone());
                    break;
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    let stop = serde_json::json!({ "type": "stop_capture" });
    let _ = state.try_send_agent_command_json(agent_id, &stop);

    let Some(j) = jpeg else {
        return;
    };
    let _ = db::alert_rule_event_screenshot_upsert(&state.db, event_id, j.as_ref()).await;
}
