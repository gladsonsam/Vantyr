//! Screen-history day-narrative worker.
//!
//! Every ~15 min it refreshes `activity_segments` + `day_summaries` for each agent
//! with recent keyframes, by segmenting `window_events` and categorizing by app/title
//! (rule-based baseline). When an OpenAI-compatible provider is configured
//! (`SCREEN_HISTORY_AI_*`), it additionally asks a vision model for a natural-language
//! narrative, sampling a few keyframes; any failure falls back to the rule-based text.
//!
//! Work is **incremental**, which matters because the naive version re-derived every
//! agent's whole day — vision call included — on every tick:
//!
//! * Each agent's local day is fingerprinted from its segments. An unchanged
//!   fingerprint means the tick would produce an identical summary, so it is skipped.
//! * Vision calls are rate-limited per agent-day ([`AI_MIN_INTERVAL`]) rather than
//!   running once per tick, with one guaranteed final call once the day closes.
//! * Days are `finalized` when their window closes, after which they're skipped on a
//!   single cheap read — which is what makes re-checking the previous
//!   [`BACKFILL_DAYS`] on every tick affordable. That backfill exists so a day whose
//!   final hours were missed (restart at midnight, agent offline at day end) gets
//!   completed instead of staying silently truncated.
//! * Agents are processed with bounded concurrency so one slow provider call can't
//!   stall the rest of the fleet behind it.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use chrono::{DateTime, Utc};
use futures_util::stream::{FuturesUnordered, StreamExt as _};
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
/// How many days back to look for unfinalized summaries on each tick. Covers a
/// server restart or an agent that was offline over a day boundary.
const BACKFILL_DAYS: i64 = 2;
/// Agents summarized concurrently. Keeps one slow vision call from stalling the
/// fleet without opening an HTTP request per agent at once.
const MAX_CONCURRENT_AGENTS: usize = 4;
/// Minimum spacing between vision-model calls for the *same* agent-day.
///
/// Without this the worker re-narrated each in-progress day on every 15-minute tick,
/// so the AI cost of one day grew with the number of ticks in it. The cheap
/// rule-based rebuild still runs on every tick, so segments and totals stay live.
const AI_MIN_INTERVAL: chrono::Duration = chrono::Duration::minutes(90);

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
    // Wide enough to cover every timezone's "recent days" (UTC-12..UTC+14) plus the
    // backfill window, so an agent in any zone is picked up as a candidate. The
    // per-agent local days are then computed below in that agent's own zone.
    let scan_from = now - chrono::Duration::hours(24 * (BACKFILL_DAYS + 2));
    let agents = db::agents_with_frames_between(&state.db, scan_from, now).await?;
    if agents.is_empty() {
        return Ok(());
    }
    debug!(count = agents.len(), "screen-narrative: summarizing agents");

    // Bounded concurrency: one agent with a slow vision call must not delay every
    // other agent's summary behind it, but an unbounded fan-out would open a
    // connection and an HTTP request per agent at once.
    let mut pending = agents.into_iter();
    let mut in_flight = FuturesUnordered::new();
    loop {
        while in_flight.len() < MAX_CONCURRENT_AGENTS {
            let Some(agent_id) = pending.next() else { break };
            in_flight.push(summarize_agent(state, agent_id, now));
        }
        if in_flight.next().await.is_none() {
            break;
        }
    }
    Ok(())
}

/// Summarize every candidate local day for one agent (today, plus recent days that
/// were never finalized).
async fn summarize_agent(state: &Arc<AppState>, agent_id: uuid::Uuid, now: DateTime<Utc>) {
    let tz = state.agent_timezone(agent_id).await;
    // The agent's *local* today. Summarizing a UTC day would give anyone east or west
    // of UTC a "day" that starts mid-morning and spans two calendar dates.
    let local_today = now.with_timezone(&tz).date_naive();

    // Walk backwards from today. Previous days are almost always already finalized,
    // in which case `summarize_agent_day` returns after a single cheap state read —
    // that's what makes backfilling affordable on every tick. It exists so a day
    // whose final hours were missed (server restart at midnight, agent offline at
    // day end) gets completed rather than being silently truncated forever.
    for back in 0..=BACKFILL_DAYS {
        let Some(day) = local_today.checked_sub_signed(chrono::Duration::days(back)) else {
            continue;
        };
        let Some(day_start) = local_midnight_utc(day, tz) else {
            warn!(%agent_id, %day, "screen-narrative: could not resolve local midnight; skipping");
            continue;
        };
        if let Err(e) = summarize_agent_day(state, agent_id, day, day_start, now, tz).await {
            warn!(%agent_id, %day, "screen-narrative: agent summary failed: {e}");
        }
    }
}

/// Midnight on `d` in `tz` as a UTC instant, resolving DST gaps forward and DST
/// overlaps to the earlier instant. Mirrors the API's `local_midnight` so the
/// worker writes exactly the day rows the read path asks for.
fn local_midnight_utc(d: chrono::NaiveDate, tz: chrono_tz::Tz) -> Option<DateTime<Utc>> {
    use chrono::offset::LocalResult;
    let naive = d.and_hms_opt(0, 0, 0)?;
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(dt) => Some(dt.with_timezone(&Utc)),
        LocalResult::Ambiguous(earlier, _) => Some(earlier.with_timezone(&Utc)),
        LocalResult::None => (1..=8).find_map(|i| {
            tz.from_local_datetime(&(naive + chrono::Duration::minutes(15 * i)))
                .earliest()
                .map(|dt| dt.with_timezone(&Utc))
        }),
    }
}

use chrono::TimeZone as _;

async fn summarize_agent_day(
    state: &Arc<AppState>,
    agent_id: uuid::Uuid,
    local_day: chrono::NaiveDate,
    day_start: DateTime<Utc>,
    now: DateTime<Utc>,
    tz: chrono_tz::Tz,
) -> anyhow::Result<()> {
    // Local, not `day_start + 24h`: a DST transition makes the local day 23 or 25
    // hours long, and using a fixed 24h window would leak an hour into the next day.
    let day_end = local_day
        .succ_opt()
        .and_then(|next| local_midnight_utc(next, tz))
        .unwrap_or(day_start + chrono::Duration::days(1));

    let state_row = db::day_summary_state(&state.db, agent_id, local_day).await?;
    let day_is_over = now >= day_end;

    // A finalized day is immutable: its window has closed and it has had its last
    // pass. Skipping here after one cheap read is what makes backfilling every tick
    // affordable.
    if state_row.as_ref().is_some_and(|s| s.finalized) {
        return Ok(());
    }

    // Only summarize up to "now" — a day still in progress has no events past it.
    let upper = day_end.min(now);
    let focus = db::window_events_for_range(&state.db, agent_id, day_start, upper).await?;
    let segments = build_segments(&focus, upper);
    if segments.is_empty() {
        return Ok(());
    }

    let content_hash = segments_fingerprint(&segments);
    let unchanged = state_row
        .as_ref()
        .and_then(|s| s.content_hash.as_deref())
        .is_some_and(|h| h == content_hash);

    // Nothing new happened and we already have a narrative. Skip unless the day just
    // ended and still needs its finalizing pass.
    if unchanged
        && state_row.as_ref().is_some_and(|s| s.has_narrative)
        && !day_is_over
    {
        return Ok(());
    }

    let (totals, top_apps, highlights) = aggregate(&segments);
    let rule_narrative = rule_based_narrative(&segments, &totals, &top_apps);

    // Optional AI enrichment (never a hard dependency). Rate-limited per agent-day:
    // re-narrating an in-progress day on every tick multiplied the cost of a single
    // day by the number of ticks in it. A finished day always gets one last call so
    // its narrative covers the whole day rather than whenever the last tick landed.
    let last_ai = state_row.as_ref().and_then(|s| s.ai_generated_at);
    let ai_due = match last_ai {
        None => true,
        Some(at) => day_is_over || now - at >= AI_MIN_INTERVAL,
    };
    let want_ai = state.screen_history_ai.is_some() && ai_due && (!unchanged || day_is_over);

    let (narrative, source, ai_refreshed) = match (&state.screen_history_ai, want_ai) {
        (Some(cfg), true) => {
            match ai_narrative(state, cfg, agent_id, day_start, upper, &segments, tz).await {
                Ok(text) if !text.trim().is_empty() => (text, "ai", true),
                Ok(_) => (rule_narrative, "rule", false),
                Err(e) => {
                    warn!(%agent_id, "AI narrative failed, using rule-based: {e}");
                    (rule_narrative, "rule", false)
                }
            }
        }
        // AI not configured, not due, or nothing changed: the rule-based narrative is
        // regenerated cheaply so segments and totals stay live either way.
        _ => (rule_narrative, "rule", false),
    };

    db::replace_activity_segments(&state.db, agent_id, day_start, day_end, &segments).await?;
    db::upsert_day_summary(
        &state.db,
        db::DaySummaryWrite {
            agent_id,
            // The agent's local calendar date — the same key the read path derives
            // from its own timezone, so writes and reads agree.
            day: local_day,
            narrative: &narrative,
            totals: &totals,
            top_apps: &top_apps,
            highlights: &highlights,
            source,
            content_hash: &content_hash,
            ai_refreshed,
            finalized: day_is_over,
        },
    )
    .await?;
    Ok(())
}

/// Stable fingerprint of a day's segments.
///
/// Two runs that would produce the same summary must produce the same hash, so the
/// worker can skip the expensive path. Covers everything the summary is derived from
/// — boundaries, category, and app — so a segment merely growing at the end (the
/// common case as a day progresses) correctly reads as *changed*.
fn segments_fingerprint(segs: &[SegmentInput]) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash as _, Hasher as _};

    let mut h = DefaultHasher::new();
    segs.len().hash(&mut h);
    for s in segs {
        s.start_ts.timestamp().hash(&mut h);
        s.end_ts.timestamp().hash(&mut h);
        s.category.hash(&mut h);
        s.app.hash(&mut h);
    }
    format!("{:016x}", h.finish())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: i64, end: i64, category: &str, app: &str) -> SegmentInput {
        SegmentInput {
            start_ts: DateTime::from_timestamp(start, 0).unwrap(),
            end_ts: DateTime::from_timestamp(end, 0).unwrap(),
            category: category.into(),
            app: Some(app.into()),
            title: Some("t".into()),
            summary: None,
            distraction_score: 0.1,
            source: "rule".into(),
        }
    }

    #[test]
    fn identical_segments_hash_identically() {
        let a = vec![seg(0, 60, "dev", "code.exe"), seg(60, 120, "comms", "slack.exe")];
        let b = vec![seg(0, 60, "dev", "code.exe"), seg(60, 120, "comms", "slack.exe")];
        assert_eq!(segments_fingerprint(&a), segments_fingerprint(&b));
    }

    #[test]
    fn a_growing_final_segment_changes_the_hash() {
        // The common case as a day progresses: the last segment extends. If this
        // read as "unchanged" the summary would freeze at the first tick of the day.
        let before = vec![seg(0, 60, "dev", "code.exe")];
        let after = vec![seg(0, 300, "dev", "code.exe")];
        assert_ne!(segments_fingerprint(&before), segments_fingerprint(&after));
    }

    #[test]
    fn a_new_segment_changes_the_hash() {
        let before = vec![seg(0, 60, "dev", "code.exe")];
        let after = vec![seg(0, 60, "dev", "code.exe"), seg(60, 120, "media", "vlc.exe")];
        assert_ne!(segments_fingerprint(&before), segments_fingerprint(&after));
    }

    #[test]
    fn switching_app_or_category_changes_the_hash() {
        let base = vec![seg(0, 60, "dev", "code.exe")];
        assert_ne!(
            segments_fingerprint(&base),
            segments_fingerprint(&[seg(0, 60, "dev", "idea.exe")])
        );
        assert_ne!(
            segments_fingerprint(&base),
            segments_fingerprint(&[seg(0, 60, "media", "code.exe")])
        );
    }

    #[test]
    fn fields_not_feeding_the_summary_do_not_churn_the_hash() {
        // `summary` is derived from app/title and `source` is bookkeeping; letting
        // them into the fingerprint would trigger pointless AI re-runs.
        let mut a = seg(0, 60, "dev", "code.exe");
        let mut b = seg(0, 60, "dev", "code.exe");
        a.summary = Some("code.exe — main.rs".into());
        b.summary = None;
        a.source = "ai".into();
        b.source = "rule".into();
        assert_eq!(segments_fingerprint(&[a]), segments_fingerprint(&[b]));
    }

    #[test]
    fn empty_and_nonempty_differ() {
        assert_ne!(
            segments_fingerprint(&[]),
            segments_fingerprint(&[seg(0, 60, "dev", "code.exe")])
        );
    }

    #[test]
    fn local_midnight_matches_the_api_day_boundary() {
        // Worker and read path must agree or the worker writes rows the API can't find.
        let tz = chrono_tz::Australia::Perth;
        let d = chrono::NaiveDate::from_ymd_opt(2026, 8, 8).unwrap();
        let start = local_midnight_utc(d, tz).unwrap();
        assert_eq!(start.to_rfc3339(), "2026-08-07T16:00:00+00:00");
    }
}
