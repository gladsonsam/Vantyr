//! [Slack](https://api.slack.com/messaging/webhooks) — post to a channel via an Incoming Webhook.
//!
//! Configure `SLACK_WEBHOOK_URL` (the `https://hooks.slack.com/services/…` URL from
//! the Slack app's Incoming Webhooks page). Also works with Slack-compatible
//! webhook receivers (e.g. Mattermost).

use async_trait::async_trait;

use super::message;
use super::util::{env_trim, http_client};
use super::{AlertMatchPayload, AlertNotifier};

pub struct SlackNotifier {
    client: reqwest::Client,
    url: String,
}

impl SlackNotifier {
    pub const ID: &'static str = "slack";

    pub fn from_env() -> Option<Self> {
        let url = env_trim("SLACK_WEBHOOK_URL")?;
        if !url.starts_with("https://") && !url.starts_with("http://") {
            tracing::warn!("SLACK_WEBHOOK_URL must start with http(s)://; Slack notifier disabled");
            return None;
        }
        Some(Self {
            client: http_client(),
            url,
        })
    }
}

#[async_trait]
impl AlertNotifier for SlackNotifier {
    fn id(&self) -> &'static str {
        Self::ID
    }

    async fn notify_alert_match(&self, payload: &AlertMatchPayload) -> anyhow::Result<()> {
        let mut text = format!("*{}*\n{}", message::title(payload), message::summary(payload));
        if let Some(l) = message::link(payload) {
            text.push_str(&format!("\n<{l}|Open in Vantyr>"));
        }
        let body = serde_json::json!({ "text": text });
        let res = self.client.post(&self.url).json(&body).send().await?;
        if !res.status().is_success() {
            let status = res.status();
            let t = res.text().await.unwrap_or_default();
            anyhow::bail!("Slack returned {status}: {t}");
        }
        Ok(())
    }
}
