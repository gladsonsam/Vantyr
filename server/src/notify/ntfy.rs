//! [ntfy](https://docs.ntfy.sh/) — push to a topic on ntfy.sh or a self-hosted server.
//!
//! Configure:
//! - `NTFY_URL` — the full topic URL, e.g. `https://ntfy.sh/vantyr-alerts`.
//! - `NTFY_TOKEN` — optional access token for protected topics (sent as a Bearer token).

use async_trait::async_trait;

use super::message;
use super::util::{env_trim, http_client};
use super::{AlertMatchPayload, AlertNotifier};

pub struct NtfyNotifier {
    client: reqwest::Client,
    url: String,
    token: Option<String>,
}

impl NtfyNotifier {
    pub const ID: &'static str = "ntfy";

    pub fn from_env() -> Option<Self> {
        let url = env_trim("NTFY_URL")?;
        if !url.starts_with("https://") && !url.starts_with("http://") {
            tracing::warn!(
                "NTFY_URL must be the full topic URL (http(s)://host/topic); ntfy notifier disabled"
            );
            return None;
        }
        Some(Self {
            client: http_client(),
            url,
            token: env_trim("NTFY_TOKEN"),
        })
    }
}

#[async_trait]
impl AlertNotifier for NtfyNotifier {
    fn id(&self) -> &'static str {
        Self::ID
    }

    async fn notify_alert_match(&self, payload: &AlertMatchPayload) -> anyhow::Result<()> {
        // ntfy headers must be ASCII; the title is usually a rule name but may not
        // be, so fall back to folding it into the body when it isn't.
        let title = message::title(payload);
        let mut body = message::summary(payload);
        if let Some(l) = message::link(payload) {
            body.push('\n');
            body.push_str(l);
        }
        let mut req = self.client.post(&self.url);
        if title.is_ascii() {
            req = req.header("Title", title.as_str());
        } else {
            body = format!("{title}\n{body}");
        }
        if let Some(l) = message::link(payload) {
            req = req.header("Click", l);
        }
        req = req.header("Tags", "warning");
        if let Some(tok) = &self.token {
            req = req.header("Authorization", format!("Bearer {tok}"));
        }
        let res = req.body(body).send().await?;
        if !res.status().is_success() {
            let status = res.status();
            let t = res.text().await.unwrap_or_default();
            anyhow::bail!("ntfy returned {status}: {t}");
        }
        Ok(())
    }
}
