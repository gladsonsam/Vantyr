//! Human-readable rendering of an [`AlertMatchPayload`] shared by every provider,
//! so Slack/Discord/email/etc. all phrase an alert the same way.

use super::AlertMatchPayload;

/// Friendly label for an internal alert channel key.
pub fn channel_label(channel: &str) -> &str {
    match channel {
        "url" => "URL",
        "keys" => "Keystrokes",
        "url_category" => "URL category",
        "resource" => "Resource",
        "agent_offline" => "Agent offline",
        "test" => "Test",
        other => other,
    }
}

/// Short title line, e.g. `Vantyr: Blocked site visited`.
pub fn title(p: &AlertMatchPayload) -> String {
    if p.rule_name.trim().is_empty() {
        "Vantyr alert".to_string()
    } else {
        format!("Vantyr: {}", p.rule_name)
    }
}

/// One-line summary, e.g. `DESK-12 (URL): facebook.com`.
pub fn summary(p: &AlertMatchPayload) -> String {
    format!(
        "{} ({}): {}",
        p.agent_name,
        channel_label(&p.channel),
        p.snippet
    )
}

/// Best deep link for this alert, if the server has a public base URL configured.
pub fn link(p: &AlertMatchPayload) -> Option<&str> {
    p.dashboard_activity_url
        .as_deref()
        .or(p.dashboard_url.as_deref())
}

/// Multi-line plain-text body: title, summary, and link (when available).
pub fn plain_text(p: &AlertMatchPayload) -> String {
    let mut s = format!("{}\n{}", title(p), summary(p));
    if let Some(l) = link(p) {
        s.push('\n');
        s.push_str(l);
    }
    s
}
