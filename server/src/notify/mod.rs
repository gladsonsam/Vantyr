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

mod home_assistant;

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

        if let Some(p) = HomeAssistantNotifier::from_env() {
            providers.push(Arc::new(p));
        }

        Self { providers }
    }

    pub fn is_empty(&self) -> bool {
        self.providers.is_empty()
    }

    pub fn provider_ids(&self) -> Vec<&'static str> {
        self.providers.iter().map(|p| p.id()).collect()
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
