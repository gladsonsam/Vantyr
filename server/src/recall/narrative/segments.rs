//! Pure rule-based segmentation of window focus events: app classification, merging focuses
//! into segments, per-day aggregates and the change fingerprint.

use std::time::Duration;

use chrono::{DateTime, Utc};

use super::db::{FocusRow, SegmentInput};

/// A single focus is attributed at most this long (guards against overnight gaps
/// where one window stayed "focused" while the machine was actually idle).
const MAX_FOCUS: Duration = Duration::from_secs(15 * 60);
/// Merge consecutive same-app focuses separated by less than this into one segment.
const MERGE_GAP_SECS: i64 = 5 * 60;
/// Drop segments shorter than this (transient alt-tabs).
const MIN_SEGMENT_SECS: i64 = 20;

/// Stable fingerprint of a day's segments.
///
/// Two runs that would produce the same summary must produce the same hash, so the
/// worker can skip the expensive path. Covers everything the summary is derived from
/// — boundaries, category, and app — so a segment merely growing at the end (the
/// common case as a day progresses) correctly reads as *changed*.
pub(super) fn segments_fingerprint(segs: &[SegmentInput]) -> String {
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

    if has(&[
        "code", "devenv", "idea", "pycharm", "goland", "rider", "sublime", "vim", "nvim",
    ]) {
        ("dev", 0.1)
    } else if has(&[
        "windowsterminal",
        "powershell",
        "cmd",
        "wt.exe",
        "conhost",
        "bash",
        "wsl",
    ]) {
        ("terminal", 0.1)
    } else if has(&[
        "slack", "teams", "discord", "zoom", "outlook", "mail", "telegram", "whatsapp",
    ]) {
        ("comms", 0.4)
    } else if has(&["youtube", "netflix", "spotify", "twitch", "vlc"]) {
        ("media", 0.9)
    } else if has(&[
        "figma",
        "photoshop",
        "illustrator",
        "blender",
        "sketch",
        "affinity",
    ]) {
        ("design", 0.2)
    } else if has(&[
        "word",
        "excel",
        "powerpoint",
        "acrobat",
        "notion",
        "obsidian",
        "docs",
        "sheets",
    ]) {
        ("docs", 0.2)
    } else if has(&[
        "chrome", "firefox", "edge", "msedge", "brave", "opera", "safari",
    ]) {
        // Social/entertainment sites bump distraction even inside a browser.
        if has(&[
            "facebook",
            "instagram",
            "tiktok",
            "reddit",
            "twitter",
            "x.com",
            "9gag",
        ]) {
            ("media", 0.85)
        } else {
            ("browsing", 0.5)
        }
    } else {
        ("other", 0.5)
    }
}

pub(super) fn build_segments(focus: &[FocusRow], upper: DateTime<Utc>) -> Vec<SegmentInput> {
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

pub(super) fn aggregate(
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
    apps.sort_by_key(|(_, secs)| std::cmp::Reverse(*secs));
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

    (
        totals,
        serde_json::json!(top_apps),
        serde_json::json!(highlights),
    )
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
        let a = vec![
            seg(0, 60, "dev", "code.exe"),
            seg(60, 120, "comms", "slack.exe"),
        ];
        let b = vec![
            seg(0, 60, "dev", "code.exe"),
            seg(60, 120, "comms", "slack.exe"),
        ];
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
        let after = vec![
            seg(0, 60, "dev", "code.exe"),
            seg(60, 120, "media", "vlc.exe"),
        ];
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
        // them into the fingerprint would trigger pointless rebuilds.
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
}
