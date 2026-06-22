//! External notification providers (alert rule matches → third-party systems).
//!
//! ## Design
//!
//! - **Modular**: each provider implements [`AlertNotifier`]; new backends are new modules + registration in [`NotifyHub::from_env`].
//! - **Home Assistant**: we recommend a **long-lived access token** and **`POST /api/events/<event_type>`** (see [`home_assistant::HomeAssistantNotifier`]).
//!
//! ### Token vs “webhook only”
//!
//! - **Bearer token + `api/events/...`**: Revocable in HA, no secret in the URL, full JSON payload as `trigger.event.data` in automations. **Preferred.**
//! - **Automation webhook trigger** (opaque URL, no token): Works, but anyone who learns the URL can POST; rotation means editing the automation. Fine for homelabs if the URL stays secret.
//!
//! Keep HA automations responsible for *how* to notify (mobile app, TTS, lights); Vantyr only fires a structured event.

mod discord;
mod email;
mod home_assistant;
mod message;
mod ntfy;
mod pushover;
mod slack;
mod teams;
mod telegram;
mod util;
mod webhook;

pub use home_assistant::HomeAssistantNotifier;

use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;
use uuid::Uuid;

/// Payload for an alert rule match (after DB insert), sent to external providers.
#[derive(Clone, Debug, Serialize)]
pub struct AlertMatchPayload {
    pub event_id: i64,
    pub rule_id: i64,
    pub rule_name: String,
    pub channel: String,
    pub agent_id: Uuid,
    pub agent_name: String,
    pub snippet: String,
    pub ts: i64,

    /// Optional public deep links (set when `PUBLIC_BASE_URL` is configured on the server).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dashboard_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dashboard_activity_url: Option<String>,
}

#[async_trait]
pub trait AlertNotifier: Send + Sync {
    fn id(&self) -> &'static str;

    async fn notify_alert_match(&self, payload: &AlertMatchPayload) -> anyhow::Result<()>;
}

/// Fan-out to all configured providers (non-blocking; errors are logged).
pub struct NotifyHub {
    providers: Vec<Arc<dyn AlertNotifier>>,
}

impl NotifyHub {
    /// For tests or future programmatic registration (e.g. DB-backed providers).
    #[allow(dead_code)]
    pub fn new(providers: Vec<Arc<dyn AlertNotifier>>) -> Self {
        Self { providers }
    }

    pub fn from_env() -> Self {
        let mut providers: Vec<Arc<dyn AlertNotifier>> = Vec::new();

        // Construct every configured provider. Each `from_env` returns `None`
        // (and logs why) when its required variables are missing, so unconfigured
        // channels are simply skipped.
        macro_rules! register {
            ($ty:path) => {
                if let Some(p) = <$ty>::from_env() {
                    providers.push(Arc::new(p));
                }
            };
        }
        register!(email::EmailNotifier);
        register!(slack::SlackNotifier);
        register!(discord::DiscordNotifier);
        register!(teams::TeamsNotifier);
        register!(telegram::TelegramNotifier);
        register!(ntfy::NtfyNotifier);
        register!(pushover::PushoverNotifier);
        register!(webhook::WebhookNotifier);
        register!(HomeAssistantNotifier);

        Self { providers }
    }

    pub fn is_empty(&self) -> bool {
        self.providers.is_empty()
    }

    pub fn provider_ids(&self) -> Vec<&'static str> {
        self.providers.iter().map(|p| p.id()).collect()
    }

    /// Catalog of every supported channel with its configured/enabled state,
    /// for the admin Notifications settings page (never includes secrets).
    pub fn catalog(&self) -> Vec<ProviderInfo> {
        let enabled: std::collections::HashSet<&str> =
            self.providers.iter().map(|p| p.id()).collect();
        PROVIDER_CATALOG
            .iter()
            .map(|c| ProviderInfo {
                id: c.id,
                label: c.label,
                description: c.description,
                env_keys: c.env_keys,
                docs_url: c.docs_url,
                enabled: enabled.contains(c.id),
            })
            .collect()
    }

    /// Send a synthetic alert through every configured provider and collect a
    /// per-provider result so the UI can show which channels actually delivered.
    pub async fn send_test(&self, payload: AlertMatchPayload) -> Vec<TestResult> {
        let mut out = Vec::with_capacity(self.providers.len());
        for p in &self.providers {
            let res = p.notify_alert_match(&payload).await;
            out.push(TestResult {
                id: p.id(),
                ok: res.is_ok(),
                // Surface the real delivery error so the admin can fix their config,
                // but bound the length so a verbose provider can't flood the response.
                error: res.err().map(|e| {
                    let s = e.to_string();
                    if s.chars().count() > 300 {
                        format!("{}…", s.chars().take(300).collect::<String>())
                    } else {
                        s
                    }
                }),
            });
        }
        out
    }

    /// Spawn one task per provider; never blocks the alert hot path.
    pub fn dispatch_alert_match(&self, payload: AlertMatchPayload) {
        for p in &self.providers {
            let p = Arc::clone(p);
            let payload = payload.clone();
            tokio::spawn(async move {
                if let Err(e) = p.notify_alert_match(&payload).await {
                    tracing::warn!(
                        provider = p.id(),
                        error = %e,
                        "external notification provider failed"
                    );
                }
            });
        }
    }
}

/// Result of a single provider during a test send.
#[derive(Clone, Debug, Serialize)]
pub struct TestResult {
    pub id: &'static str,
    pub ok: bool,
    pub error: Option<String>,
}

/// A supported notification channel and how to configure it (no secrets).
#[derive(Clone, Debug, Serialize)]
pub struct ProviderInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub env_keys: &'static [&'static str],
    pub docs_url: &'static str,
    pub enabled: bool,
}

struct CatalogEntry {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    env_keys: &'static [&'static str],
    docs_url: &'static str,
}

/// The canonical list of channels, ordered by how commonly they're used. Keep in
/// sync with the `*::from_env` constructors and the `.env.example` documentation.
static PROVIDER_CATALOG: &[CatalogEntry] = &[
    CatalogEntry {
        id: email::EmailNotifier::ID,
        label: "Email (SMTP)",
        description: "Send alert emails through any SMTP server.",
        env_keys: &[
            "SMTP_HOST",
            "SMTP_FROM",
            "SMTP_TO",
            "SMTP_PORT",
            "SMTP_USERNAME",
            "SMTP_PASSWORD",
            "SMTP_TLS",
            "SMTP_SUBJECT_PREFIX",
        ],
        docs_url: "",
    },
    CatalogEntry {
        id: slack::SlackNotifier::ID,
        label: "Slack",
        description: "Post alerts to a Slack channel via an Incoming Webhook.",
        env_keys: &["SLACK_WEBHOOK_URL"],
        docs_url: "https://api.slack.com/messaging/webhooks",
    },
    CatalogEntry {
        id: discord::DiscordNotifier::ID,
        label: "Discord",
        description: "Post alerts to a Discord channel via a channel Webhook.",
        env_keys: &["DISCORD_WEBHOOK_URL"],
        docs_url: "https://support.discord.com/hc/en-us/articles/228383668",
    },
    CatalogEntry {
        id: teams::TeamsNotifier::ID,
        label: "Microsoft Teams",
        description: "Post alerts to a Teams channel via an Incoming Webhook.",
        env_keys: &["TEAMS_WEBHOOK_URL"],
        docs_url: "https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/connectors-using",
    },
    CatalogEntry {
        id: telegram::TelegramNotifier::ID,
        label: "Telegram",
        description: "Send alerts to a Telegram chat through a bot.",
        env_keys: &["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
        docs_url: "https://core.telegram.org/bots",
    },
    CatalogEntry {
        id: ntfy::NtfyNotifier::ID,
        label: "ntfy",
        description: "Push alerts to an ntfy topic (ntfy.sh or self-hosted).",
        env_keys: &["NTFY_URL", "NTFY_TOKEN"],
        docs_url: "https://docs.ntfy.sh/",
    },
    CatalogEntry {
        id: pushover::PushoverNotifier::ID,
        label: "Pushover",
        description: "Send push notifications to your devices via Pushover.",
        env_keys: &["PUSHOVER_TOKEN", "PUSHOVER_USER_KEY"],
        docs_url: "https://pushover.net/api",
    },
    CatalogEntry {
        id: webhook::WebhookNotifier::ID,
        label: "Webhook",
        description: "POST the raw alert JSON to any HTTP endpoint.",
        env_keys: &["NOTIFY_WEBHOOK_URL", "NOTIFY_WEBHOOK_AUTH_HEADER"],
        docs_url: "",
    },
    CatalogEntry {
        id: HomeAssistantNotifier::ID,
        label: "Home Assistant",
        description: "Fire a custom event into Home Assistant for your automations.",
        env_keys: &[
            "HOME_ASSISTANT_URL",
            "HOME_ASSISTANT_ACCESS_TOKEN",
            "HOME_ASSISTANT_EVENT_TYPE",
            "HOME_ASSISTANT_SKIP_TLS_VERIFY",
        ],
        docs_url: "https://www.home-assistant.io/docs/automation/trigger/#event-trigger",
    },
];

#[cfg(test)]
mod tests {
    use super::PROVIDER_CATALOG;
    use std::collections::HashSet;

    /// Guards against the catalog drifting from the registered providers: every
    /// channel must appear exactly once, and the id set must match the canonical
    /// list. Adding/removing a channel intentionally requires updating this list,
    /// which forces `from_env`, the provider `ID`s, and the catalog to stay in sync.
    #[test]
    fn catalog_ids_are_unique_and_canonical() {
        let ids: Vec<&str> = PROVIDER_CATALOG.iter().map(|c| c.id).collect();
        let set: HashSet<&str> = ids.iter().copied().collect();
        assert_eq!(set.len(), ids.len(), "duplicate id in PROVIDER_CATALOG");

        let expected: HashSet<&str> = [
            super::email::EmailNotifier::ID,
            super::slack::SlackNotifier::ID,
            super::discord::DiscordNotifier::ID,
            super::teams::TeamsNotifier::ID,
            super::telegram::TelegramNotifier::ID,
            super::ntfy::NtfyNotifier::ID,
            super::pushover::PushoverNotifier::ID,
            super::webhook::WebhookNotifier::ID,
            super::HomeAssistantNotifier::ID,
        ]
        .into_iter()
        .collect();
        assert_eq!(
            set, expected,
            "PROVIDER_CATALOG drifted from the registered providers; update NotifyHub::from_env, the provider IDs, and PROVIDER_CATALOG together"
        );
    }
}
