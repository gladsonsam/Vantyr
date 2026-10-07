//! Immutable runtime settings, resolved once at startup and read by handlers/workers.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::config::ScreenHistoryAi;
use crate::http::trusted_proxy::TrustedProxies;

/// Configuration handlers and background workers consult at runtime. Built once
/// at startup; never mutated afterwards.
pub struct Settings {
    pub allow_insecure_dashboard_open: bool,
    /// Per-agent Wake-on-LAN throttle (`WOL_MIN_INTERVAL_SECS`). Zero disables it.
    pub wol_min_interval: Duration,
    pub allow_remote_script: bool,

    /// When set, `GET /api/integration/agents/live` accepts `Authorization: Bearer <token>`.
    pub integration_api_token: Option<String>,

    /// Public base URL for deep links in external notifications (e.g. Home Assistant).
    /// Example: `https://vantyr.example.com`
    pub public_base_url: Option<String>,

    /// Timezone used by the scheduler when matching `fire_minute` / `day_of_week`.
    /// Defaults to UTC if `SCHEDULER_TIMEZONE` is not set or invalid.
    pub scheduler_tz: chrono_tz::Tz,

    /// Reverse proxies whose forwarding headers are trusted for security decisions
    /// (login rate limiting / lockout). Shared with the rate-limit key extractor.
    pub trusted_proxies: Arc<TrustedProxies>,

    /// Filesystem root for the screen-history ("Recall") JPEG blob store. Frame
    /// index rows are in Postgres; the bytes live under this directory.
    pub screen_history_dir: PathBuf,

    /// Optional AI provider for the screen-history day-narrative worker.
    pub screen_history_ai: Option<ScreenHistoryAi>,

    /// Base64url VAPID public key for Web Push, exposed to the frontend for
    /// `PushManager.subscribe`. `None` when Web Push is not configured.
    pub vapid_public_key: Option<String>,

    /// Always mark session/OIDC cookies `Secure` (`COOKIE_SECURE`), not only on HTTPS requests.
    pub cookie_secure: bool,

    /// Dashboard SSO provider; `None` when OIDC is not configured.
    pub oidc: Option<crate::oidc::OidcConfig>,

    /// LAN discovery settings, surfaced to the dashboard as agent setup hints.
    pub mdns: crate::mdns_broadcast::MdnsConfig,
}

#[cfg(test)]
impl Settings {
    /// Everything off, UTC, and the system temp dir as the blob root. Tests
    /// override individual fields with struct-update syntax.
    pub fn for_tests() -> Self {
        Self {
            allow_insecure_dashboard_open: false,
            wol_min_interval: Duration::ZERO,
            allow_remote_script: false,
            integration_api_token: None,
            public_base_url: None,
            scheduler_tz: chrono_tz::UTC,
            trusted_proxies: Arc::new(TrustedProxies::default()),
            screen_history_dir: std::env::temp_dir(),
            screen_history_ai: None,
            vapid_public_key: None,
            cookie_secure: false,
            oidc: None,
            mdns: crate::mdns_broadcast::MdnsConfig {
                disabled: true,
                wss_url: None,
                port: 0,
                addresses: None,
                computer_name: "vantyr".into(),
            },
        }
    }
}
