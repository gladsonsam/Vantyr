//! [Home Assistant](https://www.home-assistant.io/) — fire a custom event via REST API.
//!
//! Configure:
//! - `HOME_ASSISTANT_URL` — base URL, e.g. `https://homeassistant.local:8123`
//! - `HOME_ASSISTANT_ACCESS_TOKEN` — long-lived token (Profile → Security)
//! - `HOME_ASSISTANT_EVENT_TYPE` — optional, default `vantyr_alert` (must be `[a-z0-9_]+`)
//!
//! Example automation trigger:
//! ```yaml
//! trigger:
//!   - platform: event
//!     event_type: vantyr_alert
//! action:
//!   - service: notify.mobile_app_your_phone
//!     data:
//!       title: "Vantyr alert"
//!       message: "{{ trigger.event.data.rule_name }} — {{ trigger.event.data.agent_name }}"
//! ```

use std::time::Duration;

use async_trait::async_trait;
use reqwest::Client;
use serde_json::Value;

use super::{AlertMatchPayload, AlertNotifier};

fn env_trim(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn env_bool(key: &str) -> bool {
    matches!(
        env_trim(key).as_deref(),
        Some("1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON")
    )
}

fn normalize_base_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

fn valid_ha_event_type(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 100
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

pub struct HomeAssistantNotifier {
    client: Client,
    post_url: String,
    token: String,
}

impl HomeAssistantNotifier {
    /// Returns `None` if HA is not configured (both URL and token required).
    pub fn from_env() -> Option<Self> {
        let base = env_trim("HOME_ASSISTANT_URL")?;
        let token = env_trim("HOME_ASSISTANT_ACCESS_TOKEN")?;
        let event_type =
            env_trim("HOME_ASSISTANT_EVENT_TYPE").unwrap_or_else(|| "vantyr_alert".to_string());
        if !valid_ha_event_type(&event_type) {
            tracing::warn!(
                event_type = %event_type,
                "HOME_ASSISTANT_EVENT_TYPE invalid; use lowercase letters, digits, underscores (e.g. vantyr_alert). Home Assistant notifier disabled."
            );
            return None;
        }
        let base = normalize_base_url(&base);
        if !base.starts_with("http://") && !base.starts_with("https://") {
            tracing::warn!("HOME_ASSISTANT_URL must start with http:// or https://");
            return None;
        }

        let skip_verify = env_bool("HOME_ASSISTANT_SKIP_TLS_VERIFY");
        if skip_verify {
            tracing::warn!("HOME_ASSISTANT_SKIP_TLS_VERIFY is enabled; TLS certificate verification is disabled for Home Assistant calls.");
        }

        let mut builder = Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("vantyr-server/notify-home-assistant");
        if skip_verify {
            builder = builder.danger_accept_invalid_certs(true);
        }
        let client = builder.build().ok()?;

        let post_url = format!("{base}/api/events/{event_type}");
        Some(Self {
            client,
            post_url,
            token,
        })
    }
}

#[async_trait]
impl AlertNotifier for HomeAssistantNotifier {
    fn id(&self) -> &'static str {
        "home_assistant"
    }

    async fn notify_alert_match(&self, payload: &AlertMatchPayload) -> anyhow::Result<()> {
        let body: Value = serde_json::to_value(payload)?;
        let res = self
            .client
            .post(&self.post_url)
            .header("Authorization", format!("Bearer {}", self.token))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            anyhow::bail!("Home Assistant returned {status}: {text}");
        }
        Ok(())
    }
}
