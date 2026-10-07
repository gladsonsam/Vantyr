//! Screen-history day-narrative worker.
//!
//! Every ~15 min it refreshes `activity_segments` + `day_summaries` for each agent
//! with recent keyframes, by segmenting `window_events` and categorizing by app/title
//! with the rule-based narrative.
//!
//! Work is **incremental**, which matters because the naive version re-derived every
//! agent's whole day on every tick:
//!
//! * Each agent's local day is fingerprinted from its segments. An unchanged
//!   fingerprint means the tick would produce an identical summary, so it is skipped.
//! * Days are `finalized` when their window closes, after which they're skipped on a
//!   single cheap read — which is what makes re-checking the previous
//!   [`BACKFILL_DAYS`] on every tick affordable. That backfill exists so a day whose
//!   final hours were missed (restart at midnight, agent offline at day end) gets
//!   completed instead of staying silently truncated.
//! * Agents are processed with bounded concurrency so one slow day can't stall the
//!   rest of the fleet behind it.

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures_util::stream::{FuturesUnordered, StreamExt as _};
use tracing::{debug, warn};

use crate::recall::local_day::local_midnight;
use crate::state::AppState;

pub mod db;
mod prose;
mod segments;

use prose::rule_based_narrative;
use segments::{aggregate, build_segments, segments_fingerprint};

/// How many days back to look for unfinalized summaries on each tick. Covers a
/// server restart or an agent that was offline over a day boundary.
const BACKFILL_DAYS: i64 = 2;
/// Agents summarized concurrently. Keeps one slow day from stalling the rest of
/// the fleet without fanning out unbounded work at once.
const MAX_CONCURRENT_AGENTS: usize = 4;

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

    // Bounded concurrency: one agent with a slow day must not delay every other
    // agent's summary behind it, but an unbounded fan-out would spike DB load.
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
        let Some(day_start) = local_midnight(day, tz) else {
            warn!(%agent_id, %day, "screen-narrative: could not resolve local midnight; skipping");
            continue;
        };
        if let Err(e) = summarize_agent_day(state, agent_id, day, day_start, now, tz).await {
            warn!(%agent_id, %day, "screen-narrative: agent summary failed: {e}");
        }
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
        .and_then(|next| local_midnight(next, tz))
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
    let narrative = rule_based_narrative(&segments, &totals, &top_apps);

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
            source: "rule",
            content_hash: &content_hash,
            finalized: day_is_over,
        },
    )
    .await?;
    Ok(())
}
