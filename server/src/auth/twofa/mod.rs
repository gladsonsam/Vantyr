//! TOTP (RFC 6238) helpers for optional, per-user dashboard 2FA.
//!
//! Secrets are stored base32-encoded in `dashboard_users.totp_secret`. Recovery
//! codes are generated here but hashed (Argon2) before storage by the DB layer.

use std::sync::Arc;

use anyhow::{anyhow, Result};
use axum::{
    routing::{get, post},
    Router,
};
use rand::RngExt;
use totp_rs::{Algorithm, Builder, Secret, Totp};

use crate::state::AppState;

mod api;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/2fa/status", get(api::twofa_status))
        .route("/2fa/setup", post(api::twofa_setup))
        .route("/2fa/enable", post(api::twofa_enable))
        .route("/2fa/disable", post(api::twofa_disable))
}

const ISSUER: &str = "Vantyr";

fn build(secret_b32: &str, account: &str) -> Result<Totp> {
    let secret =
        Secret::try_from_base32(secret_b32).map_err(|e| anyhow!("invalid TOTP secret: {e:?}"))?;
    Builder::new()
        .with_algorithm(Algorithm::SHA1)
        .with_digits(6)
        .with_skew(1)
        .with_step_duration(30)
        .with_secret(secret)
        .with_issuer(Some(ISSUER))
        .with_account_name(account)
        .build()
        .map_err(|e| anyhow!("TOTP build failed: {e}"))
}

/// Generate a fresh base32 secret plus its `otpauth://` provisioning URI.
pub fn generate_secret(account: &str) -> Result<(String, String)> {
    let mut raw = [0u8; 20];
    rand::rng().fill(&mut raw[..]);
    let secret_b32 = Secret::from(raw).to_base32();
    let totp = build(&secret_b32, account)?;
    let uri = totp.to_url().map_err(|e| anyhow!("TOTP URL failed: {e}"))?;
    Ok((secret_b32, uri))
}

/// Verify a 6-digit code against a stored base32 secret (±1 time-step skew).
pub fn verify(secret_b32: &str, code: &str) -> bool {
    let code = code.trim();
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    match build(secret_b32, "vantyr") {
        Ok(totp) => totp.check_current(code).is_some(),
        Err(_) => false,
    }
}

/// Generate `n` human-friendly single-use recovery codes (e.g. `abcd-efgh`).
pub fn generate_recovery_codes(n: usize) -> Vec<String> {
    // Unambiguous alphabet (no l/1/o/0).
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
    let mut rng = rand::rng();
    let part = |rng: &mut rand::rngs::ThreadRng| -> String {
        (0..4)
            .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
            .collect()
    };
    (0..n)
        .map(|_| format!("{}-{}", part(&mut rng), part(&mut rng)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_rfc6238_tokens_and_provisioning_parameters() {
        let secret = Secret::from(*b"12345678901234567890").to_base32();
        let totp = build(&secret, "person@example.com").unwrap();
        assert_eq!(totp.generate(59).to_string(), "287082");
        assert!(totp.check("287082", 59).is_some());
        assert!(totp.check("287082", 89).is_some());
        assert!(totp.check("287082", 119).is_none());
        let uri = url::Url::parse(&totp.to_url().unwrap()).unwrap();
        let params: std::collections::BTreeMap<_, _> = uri.query_pairs().into_owned().collect();
        assert_eq!(uri.scheme(), "otpauth");
        assert_eq!(params["secret"], secret);
        assert_eq!(params["issuer"], "Vantyr");
        assert_eq!(params.get("digits").map_or("6", String::as_str), "6");
        assert_eq!(params.get("period").map_or("30", String::as_str), "30");
    }
}
