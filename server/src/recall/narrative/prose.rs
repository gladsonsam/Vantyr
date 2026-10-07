//! Rule-based prose narrative for a day.

use super::db::SegmentInput;

/// Rule-based prose narrative. Deliberately qualitative — no durations or counts;
/// the UI carries the "shape of the day" visually.
pub(super) fn rule_based_narrative(
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
    cats.sort_by_key(|(_, secs)| std::cmp::Reverse(*secs));
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
