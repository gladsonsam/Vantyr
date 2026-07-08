//! Screen-history day-narrative worker (Phase 3).
//!
//! Every ~15 min it rebuilds today's `activity_segments` + `day_summaries` for each
//! agent with recent keyframes, by segmenting `window_events` and categorizing by
//! app/title (rule-based baseline). When an OpenAI-compatible provider is configured
//! (`SCREEN_HISTORY_AI_*`), it additionally asks a vision model for a natural-language
//! narrative, sampling a few keyframes; any failure falls back to the rule-based text.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use chrono::{DateTime, Utc};
use tracing::{debug, info, warn};

use crate::config::ScreenHistoryAi;
use crate::db::{self, FocusRow, SegmentInput};
use crate::state::AppState;

/// A single focus is attributed at most this long (guards against overnight gaps
/// where one window stayed "focused" while the machine was actually idle).
const MAX_FOCUS: Duration = Duration::from_secs(15 * 60);
/// Merge consecutive same-app focuses separated by less than this into one segment.
const MERGE_GAP_SECS: i64 = 5 * 60;
/// Drop segments shorter than this (transient alt-tabs).
const MIN_SEGMENT_SECS: i64 = 20;
/// Max keyframes attached to the AI vision call.
const AI_MAX_IMAGES: usize = 4;

pub fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        // Small initial delay so startup isn't contended, then run on a fixed cadence.
        tokio::time::sleep(Duration::from_secs(30)).await;
        let mut interval = tokio::time::interval(Duration::from_secs(15 * 60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if let Err(e) = run_once(&state).await {
                warn!("screen-narrative tick error: {e}");
            }
        }
    });
}

async fn run_once(state: &Arc<AppState>) -> anyhow::Result<()> {
    let now = Utc::now();
    let today = now.date_naive();
    let day_start = Utc.from_utc_datetime(&today.and_hms_opt(0, 0, 0).unwrap());
    // Only summarize up to "now" for today.
    let agents = db::agents_with_frames_between(&state.db, day_start, now).await?;
    if agents.is_empty() {
        return Ok(());
    }
    debug!(count = agents.len(), "screen-narrative: summarizing agents for today");
    for agent_id in agents {
        if let Err(e) = summarize_agent_day(state, agent_id, day_start, now).await {
            warn!(%agent_id, "screen-narrative: agent summary failed: {e}");
        }
    }
    Ok(())
}

use chrono::TimeZone as _;

async fn summarize_agent_day(
    state: &Arc<AppState>,
    agent_id: uuid::Uuid,
    day_start: DateTime<Utc>,
    now: DateTime<Utc>,
) -> anyhow::Result<()> {
    let day_end = day_start + chrono::Duration::days(1);
    let focus = db::window_events_for_range(&state.db, agent_id, day_start, now).await?;
    let segments = build_segments(&focus, now);
    if segments.is_empty() {
        return Ok(());
    }

    let (totals, top_apps, highlights) = aggregate(&segments);
    let rule_narrative = rule_based_narrative(&segments, &totals, &top_apps);

    // Optional AI enrichment (never a hard dependency).
    let (narrative, source) = match &state.screen_history_ai {
        Some(cfg) => {
            match ai_narrative(state, cfg, agent_id, day_start, now, &segments).await {
                Ok(text) if !text.trim().is_empty() => (text, "ai"),
                Ok(_) => (rule_narrative, "rule"),
                Err(e) => {
                    warn!(%agent_id, "AI narrative failed, using rule-based: {e}");
                    (rule_narrative, "rule")
                }
            }
        }
        None => (rule_narrative, "rule"),
    };

    db::replace_activity_segments(&state.db, agent_id, day_start, day_end, &segments).await?;
    db::upsert_day_summary(
        &state.db,
        agent_id,
        day_start.date_naive(),
        &narrative,
        &totals,
        &top_apps,
        &highlights,
        source,
    )
    .await?;
    Ok(())
}

/// Coarse category + a 0..1 distraction score for an app/title pair.
fn classify(app: &str, title: &str) -> (&'static str, f32) {
    let a = app.to_ascii_lowercase();
    let t = title.to_ascii_lowercase();
    let has = |nks: &[&str]| nks.iter().any(|n| a.contains(n) || t.contains(n));

    if has(&["code", "devenv", "idea", "pycharm", "goland", "rider", "sublime", "vim", "nvim"]) {
        ("dev", 0.1)
    } else if has(&["windowsterminal", "powershell", "cmd", "wt.exe", "conhost", "bash", "wsl"]) {
        ("terminal", 0.1)
    } else if has(&["slack", "teams", "discord", "zoom", "outlook", "mail", "telegram", "whatsapp"]) {
        ("comms", 0.4)
    } else if has(&["youtube", "netflix", "spotify", "twitch", "vlc"]) {
        ("media", 0.9)
    } else if has(&["figma", "photoshop", "illustrator", "blender", "sketch", "affinity"]) {
        ("design", 0.2)
    } else if has(&["word", "excel", "powerpoint", "acrobat", "notion", "obsidian", "docs", "sheets"]) {
        ("docs", 0.2)
    } else if has(&["chrome", "firefox", "edge", "msedge", "brave", "opera", "safari"]) {
        // Social/entertainment sites bump distraction even inside a browser.
        if has(&["facebook", "instagram", "tiktok", "reddit", "twitter", "x.com", "9gag"]) {
            ("media", 0.85)
        } else {
            ("browsing", 0.5)
        }
    } else {
        ("other", 0.5)
    }
}

fn build_segments(focus: &[FocusRow], upper: DateTime<Utc>) -> Vec<SegmentInput> {
    let max_focus = chrono::Duration::from_std(MAX_FOCUS).unwrap();
    let mut segs: Vec<SegmentInput> = Vec::new();

    for (i, row) in focus.iter().enumerate() {
        let next_ts = focus.get(i + 1).map(|r| r.ts).unwrap_or(upper);
        let raw = next_ts - row.ts;
        let dur = raw.clamp(chrono::Duration::zero(), max_focus);
        let end = row.ts + dur;
        let (category, score) = classify(&row.app, &row.title);

        if let Some(last) = segs.last_mut() {
            let same_app = last.app.as_deref() == Some(row.app.as_str());
            let contiguous = (row.ts - last.end_ts).num_seconds() <= MERGE_GAP_SECS;
            if same_app && contiguous {
                last.end_ts = end;
                if !row.title.is_empty() {
                    last.title = Some(row.title.clone());
                }
                continue;
            }
        }

        segs.push(SegmentInput {
            start_ts: row.ts,
            end_ts: end,
            category: category.to_string(),
            app: Some(row.app.clone()).filter(|s| !s.is_empty()),
            title: Some(row.title.clone()).filter(|s| !s.is_empty()),
            summary: None,
            distraction_score: score,
            source: "rule".to_string(),
        });
    }

    // Fill in per-segment summaries and drop trivially short ones.
    segs.retain(|s| (s.end_ts - s.start_ts).num_seconds() >= MIN_SEGMENT_SECS);
    for s in &mut segs {
        let app = s.app.as_deref().unwrap_or("app");
        s.summary = Some(match &s.title {
            Some(t) if !t.is_empty() => format!("{app} — {}", truncate(t, 80)),
            _ => app.to_string(),
        });
    }
    segs
}

fn aggregate(
    segs: &[SegmentInput],
) -> (serde_json::Value, serde_json::Value, serde_json::Value) {
    use std::collections::HashMap;
    let mut by_category: HashMap<&str, i64> = HashMap::new();
    let mut by_app: HashMap<String, i64> = HashMap::new();
    let mut active = 0i64;
    for s in segs {
        let secs = (s.end_ts - s.start_ts).num_seconds().max(0);
        active += secs;
        *by_category.entry(s.category.as_str()).or_default() += secs;
        if let Some(app) = &s.app {
            *by_app.entry(app.clone()).or_default() += secs;
        }
    }

    let totals = serde_json::json!({
        "active_seconds": active,
        "segment_count": segs.len(),
        "by_category": by_category,
    });

    let mut apps: Vec<(String, i64)> = by_app.into_iter().collect();
    apps.sort_by(|a, b| b.1.cmp(&a.1));
    let top_apps: Vec<serde_json::Value> = apps
        .into_iter()
        .take(6)
        .map(|(app, seconds)| serde_json::json!({ "app": app, "seconds": seconds }))
        .collect();

    // Highlights = the 3 longest segments.
    let mut by_len: Vec<&SegmentInput> = segs.iter().collect();
    by_len.sort_by_key(|s| -(s.end_ts - s.start_ts).num_seconds());
    let highlights: Vec<serde_json::Value> = by_len
        .into_iter()
        .take(3)
        .map(|s| {
            serde_json::json!({
                "label": s.summary.clone().unwrap_or_else(|| s.category.clone()),
                "category": s.category,
                "start_ts": s.start_ts,
                "end_ts": s.end_ts,
            })
        })
        .collect();

    (totals, serde_json::json!(top_apps), serde_json::json!(highlights))
}

/// Rule-based prose narrative. Deliberately qualitative — no durations or counts;
/// the UI carries the "shape of the day" visually.
fn rule_based_narrative(
    segs: &[SegmentInput],
    totals: &serde_json::Value,
    top_apps: &serde_json::Value,
) -> String {
    let active = totals["active_seconds"].as_i64().unwrap_or(0);
    let top_app = top_apps
        .as_array()
        .and_then(|a| a.first())
        .and_then(|v| v["app"].as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("several apps");

    // Categories by time spent, largest first — as words, not figures.
    let mut cats: Vec<(String, i64)> = totals["by_category"]
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), v.as_i64().unwrap_or(0)))
                .collect()
        })
        .unwrap_or_default();
    cats.sort_by(|a, b| b.1.cmp(&a.1));
    let cat_words: Vec<String> = cats
        .iter()
        .take(3)
        .map(|(c, _)| pretty_category(c).to_string())
        .collect();

    let distraction: i64 = segs
        .iter()
        .filter(|s| s.distraction_score >= 0.7)
        .map(|s| (s.end_ts - s.start_ts).num_seconds().max(0))
        .sum();

    let mut out = format!("Mostly worked in {top_app}");
    if !cat_words.is_empty() {
        out.push_str(&format!(", across {}", join_and(&cat_words)));
    }
    out.push('.');

    if active > 0 {
        let share = distraction as f64 / active as f64;
        if share >= 0.25 {
            out.push_str(" A fair part of the day drifted into media or social browsing.");
        } else if distraction > 0 {
            out.push_str(" Focus held up well, with only short breaks.");
        } else {
            out.push_str(" A focused, heads-down day.");
        }
    }
    out
}

fn pretty_category(cat: &str) -> &'static str {
    match cat {
        "dev" => "development",
        "terminal" => "terminal work",
        "browsing" => "browsing",
        "comms" => "communication",
        "docs" => "documents",
        "design" => "design",
        "media" => "media",
        _ => "other apps",
    }
}

fn join_and(items: &[String]) -> String {
    match items.len() {
        0 => String::new(),
        1 => items[0].clone(),
        2 => format!("{} and {}", items[0], items[1]),
        _ => {
            let (last, rest) = items.split_last().unwrap();
            format!("{}, and {}", rest.join(", "), last)
        }
    }
}

/// Optional OpenAI-compatible vision narrative. Errors bubble up so the caller can
/// fall back to rule-based text.
async fn ai_narrative(
    state: &Arc<AppState>,
    cfg: &ScreenHistoryAi,
    agent_id: uuid::Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    segs: &[SegmentInput],
) -> anyhow::Result<String> {
    // Build a compact text digest of the day's segments.
    let mut digest = String::new();
    for s in segs.iter().take(60) {
        digest.push_str(&format!(
            "- {}–{} [{}] {}\n",
            s.start_ts.format("%H:%M"),
            s.end_ts.format("%H:%M"),
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
        let path = state.screen_history_dir.join(blob_ref);
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

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push('…');
        out
    }
}
