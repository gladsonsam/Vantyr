//! [Telegram](https://core.telegram.org/bots) — send a message via the Bot API.
//!
//! Configure:
//! - `TELEGRAM_BOT_TOKEN` — from @BotFather.
//! - `TELEGRAM_CHAT_ID` — numeric chat id, or `@channelusername` for a channel the
//!   bot can post to. (Send the bot a message, then read `getUpdates` to find the id.)

use async_trait::async_trait;

use super::message;
use super::util::{env_trim, http_client};
use super::{AlertMatchPayload, AlertNotifier};

pub struct TelegramNotifier {
    client: reqwest::Client,
    api_url: String,
    chat_id: String,
}

impl TelegramNotifier {
    pub const ID: &'static str = "telegram";

    pub fn from_env() -> Option<Self> {
        let token = env_trim("TELEGRAM_BOT_TOKEN")?;
        let chat_id = env_trim("TELEGRAM_CHAT_ID")?;
        Some(Self {
            client: http_client(),
            api_url: format!("https://api.telegram.org/bot{token}/sendMessage"),
            chat_id,
        })
    }
}

#[async_trait]
impl AlertNotifier for TelegramNotifier {
    fn id(&self) -> &'static str {
        Self::ID
    }

    async fn notify_alert_match(&self, payload: &AlertMatchPayload) -> anyhow::Result<()> {
        let text = message::plain_text(payload);
        let body = serde_json::json!({
            "chat_id": self.chat_id,
            "text": text,
            "disable_web_page_preview": true,
        });
        let res = self.client.post(&self.api_url).json(&body).send().await?;
        if !res.status().is_success() {
            let status = res.status();
            let t = res.text().await.unwrap_or_default();
            anyhow::bail!("Telegram returned {status}: {t}");
        }
        Ok(())
    }
}
