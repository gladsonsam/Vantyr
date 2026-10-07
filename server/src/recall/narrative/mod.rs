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

use chrono::{DateTime, TimeZone as _, Utc};
use futures_util::stream::{FuturesUnordered, StreamExt as _};
use tracing::{debug, warn};

use crate::state::AppState;

mod ai;
pub mod db;
mod prose;
mod segments;

use ai::ai_narrative;
use prose::rule_based_narrative;
use segments::{aggregate, build_segments, segments_fingerprint};

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
            let Some(agent_id) = pending.next() else {
                break;
            };
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
    if unchanged && state_row.as_ref().is_some_and(|s| s.has_narrative) && !day_is_over {
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
    let want_ai =
        state.settings.screen_history_ai.is_some() && ai_due && (!unchanged || day_is_over);

    let (narrative, source, ai_refreshed) = match (&state.settings.screen_history_ai, want_ai) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_midnight_matches_the_api_day_boundary() {
        // Worker and read path must agree or the worker writes rows the API can't find.
        let tz = chrono_tz::Australia::Perth;
        let d = chrono::NaiveDate::from_ymd_opt(2026, 8, 8).unwrap();
        let start = local_midnight_utc(d, tz).unwrap();
        assert_eq!(start.to_rfc3339(), "2026-08-07T16:00:00+00:00");
    }
}
