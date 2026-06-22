//! [Microsoft Teams](https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/connectors-using)
//! — post to a channel via an Incoming Webhook connector (legacy `MessageCard`).
//!
//! Configure `TEAMS_WEBHOOK_URL` (channel → Connectors → Incoming Webhook, or a
//! Workflows "Post to a channel when a webhook request is received" URL).

use async_trait::async_trait;

use super::message;
use super::util::{env_trim, http_client};
use super::{AlertMatchPayload, AlertNotifier};

pub struct TeamsNotifier {
    client: reqwest::Client,
    url: String,
}

impl TeamsNotifier {
    pub const ID: &'static str = "teams";

    pub fn from_env() -> Option<Self> {
        let url = env_trim("TEAMS_WEBHOOK_URL")?;
        if !url.starts_with("https://") && !url.starts_with("http://") {
            tracing::warn!("TEAMS_WEBHOOK_URL must start with http(s)://; Teams notifier disabled");
            return None;
        }
        Some(Self {
            client: http_client(),
            url,
        })
    }
}

#[async_trait]
impl AlertNotifier for TeamsNotifier {
    fn id(&self) -> &'static str {
        Self::ID
    }

    async fn notify_alert_match(&self, payload: &AlertMatchPayload) -> anyhow::Result<()> {
        let mut card = serde_json::json!({
            "@type": "MessageCard",
            "@context": "http://schema.org/extensions",
            "summary": message::title(payload),
            "themeColor": "20dd8f",
            "title": message::title(payload),
            "text": message::summary(payload),
        });
        if let Some(l) = message::link(payload) {
            card["potentialAction"] = serde_json::json!([{
                "@type": "OpenUri",
                "name": "Open in Vantyr",
                "targets": [{ "os": "default", "uri": l }],
            }]);
        }
        let res = self.client.post(&self.url).json(&card).send().await?;
        if !res.status().is_success() {
            let status = res.status();
            let t = res.text().await.unwrap_or_default();
            anyhow::bail!("Microsoft Teams returned {status}: {t}");
        }
        Ok(())
    }
}
