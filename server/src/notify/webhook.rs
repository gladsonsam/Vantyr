//! Generic outgoing webhook — POST the raw alert JSON to any HTTP endpoint.
//!
//! Configure:
//! - `NOTIFY_WEBHOOK_URL` — `http(s)://…` endpoint that receives the alert payload as JSON.
//! - `NOTIFY_WEBHOOK_AUTH_HEADER` — optional. Either a full `Header: value` pair
//!   (e.g. `X-Api-Key: secret`) or a bare value sent as `Authorization`.

use async_trait::async_trait;
use serde_json::Value;

use super::util::{env_trim, http_client};
use super::{AlertMatchPayload, AlertNotifier};

pub struct WebhookNotifier {
    client: reqwest::Client,
    url: String,
    auth_header: Option<(String, String)>,
}

impl WebhookNotifier {
    pub const ID: &'static str = "webhook";

    pub fn from_env() -> Option<Self> {
        let url = env_trim("NOTIFY_WEBHOOK_URL")?;
        if !url.starts_with("http://") && !url.starts_with("https://") {
            tracing::warn!(
                "NOTIFY_WEBHOOK_URL must start with http:// or https://; webhook notifier disabled"
            );
            return None;
        }
        let auth_header = env_trim("NOTIFY_WEBHOOK_AUTH_HEADER").map(|raw| match raw.split_once(':') {
            Some((k, v)) => (k.trim().to_string(), v.trim().to_string()),
            None => ("Authorization".to_string(), raw),
        });
        Some(Self {
            client: http_client(),
            url,
            auth_header,
        })
    }
}

#[async_trait]
impl AlertNotifier for WebhookNotifier {
    fn id(&self) -> &'static str {
        Self::ID
    }

    async fn notify_alert_match(&self, payload: &AlertMatchPayload) -> anyhow::Result<()> {
        let body: Value = serde_json::to_value(payload)?;
        let mut req = self.client.post(&self.url).json(&body);
        if let Some((k, v)) = &self.auth_header {
            req = req.header(k.as_str(), v.as_str());
        }
        let res = req.send().await?;
        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            anyhow::bail!("webhook returned {status}: {text}");
        }
        Ok(())
    }
}
