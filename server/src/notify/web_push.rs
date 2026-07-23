//! Web Push (browser / PWA) notifications via VAPID.
//!
//! Unlike the other providers this one has no single endpoint: on an alert match it
//! loads every browser subscription registered through `POST /api/push/subscribe`,
//! encrypts the payload for each (RFC 8291, `aes128gcm`), signs the request with the
//! server's VAPID key, and POSTs it to that browser's push service. Subscriptions the
//! push service reports as gone (HTTP 404/410) are pruned.
//!
//! We use `web-push-native` — a pure-RustCrypto implementation (p256 / hkdf / aes-gcm /
//! jwt-simple) with **no OpenSSL** — to build and encrypt each request, then send it over
//! the project's shared rustls `reqwest` client. (The mainstream `web-push` crate was
//! rejected here: it pulls `ece` → `openssl`, which conflicts with the rustls-only stack.)

use async_trait::async_trait;
use axum::http;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use sqlx::PgPool;
use std::time::Duration;
use web_push_native::jwt_simple::algorithms::ES256KeyPair;
use web_push_native::p256::PublicKey;
use web_push_native::{Auth, WebPushBuilder};

use crate::config::VapidConfig;
use crate::db;

use super::util::http_client;
use super::{message, AlertMatchPayload, AlertNotifier};

/// Keep browsers from queueing a stale alert for too long if the device is offline.
const PUSH_TTL: Duration = Duration::from_secs(60 * 60 * 12);

pub struct WebPushNotifier {
    db: PgPool,
    client: reqwest::Client,
    public_key: String,
    private_key_b64: String,
    subject: String,
}

/// Outcome of a single push send, so the caller can prune dead endpoints.
enum SendOutcome {
    Sent,
    /// The push service says this endpoint is gone (404/410) — delete the row.
    Gone,
}

impl WebPushNotifier {
    pub const ID: &'static str = "web_push";

    /// Constructed only when VAPID keys are configured (see [`crate::config::VapidConfig`]).
    pub fn new(db: PgPool, vapid: &VapidConfig) -> Self {
        Self {
            db,
            client: http_client(),
            public_key: vapid.public_key.clone(),
            private_key_b64: vapid.private_key.clone(),
            subject: vapid.subject.clone(),
        }
    }

    /// The base64url VAPID public key the frontend needs for `applicationServerKey`.
    #[allow(dead_code)]
    pub fn public_key(&self) -> &str {
        &self.public_key
    }

    /// Build (encrypt + VAPID-sign) the HTTP push request for one subscription.
    fn build_request(
        &self,
        sub: &db::WebPushSubscription,
        content: &[u8],
    ) -> anyhow::Result<http::Request<Vec<u8>>> {
        let endpoint: http::Uri = sub
            .endpoint
            .parse()
            .map_err(|e| anyhow::anyhow!("invalid push endpoint: {e}"))?;

        let p256dh = URL_SAFE_NO_PAD
            .decode(sub.p256dh.trim())
            .map_err(|e| anyhow::anyhow!("invalid p256dh: {e}"))?;
        let ua_public = PublicKey::from_sec1_bytes(&p256dh)
            .map_err(|e| anyhow::anyhow!("invalid p256dh key: {e}"))?;

        let auth = URL_SAFE_NO_PAD
            .decode(sub.auth.trim())
            .map_err(|e| anyhow::anyhow!("invalid auth secret: {e}"))?;
        if auth.len() != 16 {
            anyhow::bail!("auth secret must be 16 bytes, got {}", auth.len());
        }
        // `auth` is exactly 16 bytes (checked above); copy into a fixed-size Auth.
        let mut ua_auth = Auth::default();
        ua_auth.copy_from_slice(&auth);

        let key_bytes = URL_SAFE_NO_PAD
            .decode(self.private_key_b64.trim())
            .map_err(|e| anyhow::anyhow!("invalid VAPID private key: {e}"))?;
        let key_pair = ES256KeyPair::from_bytes(&key_bytes)
            .map_err(|e| anyhow::anyhow!("invalid VAPID key pair: {e}"))?;

        WebPushBuilder::new(endpoint, ua_public, ua_auth)
            .with_valid_duration(PUSH_TTL)
            .with_vapid(&key_pair, &self.subject)
            .build(content.to_vec())
            .map_err(|e| anyhow::anyhow!("web push encryption failed: {e}"))
    }

    /// Send one push over the shared reqwest client.
    async fn send_one(
        &self,
        sub: &db::WebPushSubscription,
        content: &[u8],
    ) -> anyhow::Result<SendOutcome> {
        let req = self.build_request(sub, content)?;
        let (parts, body) = req.into_parts();

        let mut rb = self.client.post(parts.uri.to_string());
        for (name, value) in parts.headers.iter() {
            rb = rb.header(name.as_str(), value.as_bytes());
        }

        let res = rb.body(body).send().await?;
        let status = res.status();
        if status.is_success() {
            return Ok(SendOutcome::Sent);
        }
        if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::GONE {
            return Ok(SendOutcome::Gone);
        }
        let text = res.text().await.unwrap_or_default();
        anyhow::bail!("push service returned {status}: {text}");
    }
}

#[async_trait]
impl AlertNotifier for WebPushNotifier {
    fn id(&self) -> &'static str {
        Self::ID
    }

    async fn notify_alert_match(&self, payload: &AlertMatchPayload) -> anyhow::Result<()> {
        let subs = db::all_web_push_subscriptions(&self.db).await?;
        if subs.is_empty() {
            // Surface this on the admin "Send test" so it's clear no device is enrolled
            // yet (the notifier is configured, there's just nothing to deliver to).
            anyhow::bail!(
                "No browsers are subscribed. Open the dashboard and enable browser notifications on a device first."
            );
        }

        // The service worker's `push` handler reads these fields (see `sw.js`).
        let body = serde_json::json!({
            "title": message::title(payload),
            "body": message::summary(payload),
            "url": message::link(payload),
            "rule_name": payload.rule_name,
            "snippet": payload.snippet,
            "agent_name": payload.agent_name,
        });
        let content = serde_json::to_vec(&body)?;

        let mut sent = 0usize;
        let mut last_err: Option<String> = None;
        for sub in &subs {
            match self.send_one(sub, &content).await {
                Ok(SendOutcome::Sent) => {
                    sent += 1;
                    let _ = db::mark_web_push_success(&self.db, sub.id).await;
                }
                Ok(SendOutcome::Gone) => {
                    tracing::info!(endpoint = %sub.endpoint, "pruning expired web push subscription");
                    let _ = db::prune_web_push_subscription(&self.db, sub.id).await;
                }
                Err(e) => {
                    last_err = Some(e.to_string());
                    tracing::warn!(endpoint = %sub.endpoint, error = %e, "web push send failed");
                    let _ = db::mark_web_push_failure(&self.db, sub.id).await;
                }
            }
        }

        // Only a hard failure (nothing delivered and at least one real error) fails the
        // provider; delivering to some subscribers is a success.
        if sent == 0 {
            if let Some(err) = last_err {
                anyhow::bail!("all web push sends failed: {err}");
            }
        }
        Ok(())
    }
}
