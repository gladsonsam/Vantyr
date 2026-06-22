//! [Discord](https://support.discord.com/hc/en-us/articles/228383668) — post to a
//! channel via a channel Webhook URL.
//!
//! Configure `DISCORD_WEBHOOK_URL` (Channel → Edit → Integrations → Webhooks).

use async_trait::async_trait;

use super::message;
use super::util::{env_trim, http_client};
use super::{AlertMatchPayload, AlertNotifier};

pub struct DiscordNotifier {
    client: reqwest::Client,
    url: String,
}

impl DiscordNotifier {
    pub const ID: &'static str = "discord";

    pub fn from_env() -> Option<Self> {
        let url = env_trim("DISCORD_WEBHOOK_URL")?;
        if !url.starts_with("https://") && !url.starts_with("http://") {
            tracing::warn!(
                "DISCORD_WEBHOOK_URL must start with http(s)://; Discord notifier disabled"
            );
            return None;
        }
        Some(Self {
            client: http_client(),
            url,
        })
    }
}

#[async_trait]
impl AlertNotifier for DiscordNotifier {
    fn id(&self) -> &'static str {
        Self::ID
    }

    async fn notify_alert_match(&self, payload: &AlertMatchPayload) -> anyhow::Result<()> {
        let mut content = format!(
            "**{}**\n{}",
            message::title(payload),
            message::summary(payload)
        );
        if let Some(l) = message::link(payload) {
            content.push('\n');
            content.push_str(l);
        }
        // Discord caps message content at 2000 characters.
        if content.chars().count() > 2000 {
            content = content.chars().take(1999).collect::<String>() + "…";
        }
        let body = serde_json::json!({ "content": content });
        let res = self.client.post(&self.url).json(&body).send().await?;
        if !res.status().is_success() {
            let status = res.status();
            let t = res.text().await.unwrap_or_default();
            anyhow::bail!("Discord returned {status}: {t}");
        }
        Ok(())
    }
}
