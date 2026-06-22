//! [Pushover](https://pushover.net/api) — send a push to your devices.
//!
//! Configure:
//! - `PUSHOVER_TOKEN` — your application's API token.
//! - `PUSHOVER_USER_KEY` — the user (or group) key to deliver to.

use async_trait::async_trait;

use super::message;
use super::util::{env_trim, http_client};
use super::{AlertMatchPayload, AlertNotifier};

pub struct PushoverNotifier {
    client: reqwest::Client,
    token: String,
    user_key: String,
}

impl PushoverNotifier {
    pub const ID: &'static str = "pushover";

    pub fn from_env() -> Option<Self> {
        let token = env_trim("PUSHOVER_TOKEN")?;
        let user_key = env_trim("PUSHOVER_USER_KEY")?;
        Some(Self {
            client: http_client(),
            token,
            user_key,
        })
    }
}

#[async_trait]
impl AlertNotifier for PushoverNotifier {
    fn id(&self) -> &'static str {
        Self::ID
    }

    async fn notify_alert_match(&self, payload: &AlertMatchPayload) -> anyhow::Result<()> {
        let title = message::title(payload);
        let summary = message::summary(payload);
        let mut form: Vec<(&str, &str)> = vec![
            ("token", self.token.as_str()),
            ("user", self.user_key.as_str()),
            ("title", title.as_str()),
            ("message", summary.as_str()),
        ];
        if let Some(l) = message::link(payload) {
            form.push(("url", l));
            form.push(("url_title", "Open in Vantyr"));
        }
        let res = self
            .client
            .post("https://api.pushover.net/1/messages.json")
            .form(&form)
            .send()
            .await?;
        if !res.status().is_success() {
            let status = res.status();
            let t = res.text().await.unwrap_or_default();
            anyhow::bail!("Pushover returned {status}: {t}");
        }
        Ok(())
    }
}
