//! Email over SMTP via [`lettre`].
//!
//! Configure:
//! - `SMTP_HOST` — SMTP server hostname (required).
//! - `SMTP_FROM` — sender, e.g. `Vantyr <alerts@example.com>` or `alerts@example.com` (required).
//! - `SMTP_TO` — comma-separated recipient list (required).
//! - `SMTP_PORT` — optional; defaults to the standard port for the TLS mode.
//! - `SMTP_USERNAME` / `SMTP_PASSWORD` — optional; omit for an unauthenticated relay.
//! - `SMTP_TLS` — `starttls` (default), `implicit` (TLS-on-connect, e.g. port 465),
//!   or `none` (plaintext — avoid).
//! - `SMTP_SUBJECT_PREFIX` — optional string prepended to every subject.

use async_trait::async_trait;
use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use super::message;
use super::util::env_trim;
use super::{AlertMatchPayload, AlertNotifier};

pub struct EmailNotifier {
    mailer: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
    to: Vec<Mailbox>,
    subject_prefix: Option<String>,
}

impl EmailNotifier {
    pub const ID: &'static str = "email";

    pub fn from_env() -> Option<Self> {
        let host = env_trim("SMTP_HOST")?;
        let from_raw = env_trim("SMTP_FROM")?;
        let to_raw = env_trim("SMTP_TO")?;

        let from: Mailbox = match from_raw.parse() {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(error = %e, "SMTP_FROM is not a valid address; email notifier disabled");
                return None;
            }
        };

        let to: Vec<Mailbox> = to_raw
            .split(',')
            .filter_map(|s| {
                let t = s.trim();
                if t.is_empty() {
                    return None;
                }
                match t.parse::<Mailbox>() {
                    Ok(m) => Some(m),
                    Err(e) => {
                        tracing::warn!(addr = %t, error = %e, "skipping invalid SMTP_TO address");
                        None
                    }
                }
            })
            .collect();
        if to.is_empty() {
            tracing::warn!("SMTP_TO has no valid recipients; email notifier disabled");
            return None;
        }

        let mode = env_trim("SMTP_TLS")
            .unwrap_or_else(|| "starttls".to_string())
            .to_lowercase();
        let mut builder = match mode.as_str() {
            "none" | "plain" | "plaintext" => {
                AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&host)
            }
            "implicit" | "tls" | "ssl" | "wrapper" => {
                match AsyncSmtpTransport::<Tokio1Executor>::relay(&host) {
                    Ok(b) => b,
                    Err(e) => {
                        tracing::warn!(error = %e, "SMTP implicit-TLS setup failed; email notifier disabled");
                        return None;
                    }
                }
            }
            _ => match AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host) {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!(error = %e, "SMTP STARTTLS setup failed; email notifier disabled");
                    return None;
                }
            },
        };

        if let Some(port) = env_trim("SMTP_PORT").and_then(|p| p.parse::<u16>().ok()) {
            builder = builder.port(port);
        }
        if let (Some(u), Some(p)) = (env_trim("SMTP_USERNAME"), env_trim("SMTP_PASSWORD")) {
            builder = builder.credentials(Credentials::new(u, p));
        }

        Some(Self {
            mailer: builder.build(),
            from,
            to,
            subject_prefix: env_trim("SMTP_SUBJECT_PREFIX"),
        })
    }
}

#[async_trait]
impl AlertNotifier for EmailNotifier {
    fn id(&self) -> &'static str {
        Self::ID
    }

    async fn notify_alert_match(&self, payload: &AlertMatchPayload) -> anyhow::Result<()> {
        let subject = match &self.subject_prefix {
            Some(pre) => format!("{pre} {}", message::title(payload)),
            None => message::title(payload),
        };
        let mut builder = Message::builder().from(self.from.clone()).subject(subject);
        for t in &self.to {
            builder = builder.to(t.clone());
        }
        let email = builder.body(message::plain_text(payload))?;
        self.mailer.send(email).await?;
        Ok(())
    }
}
