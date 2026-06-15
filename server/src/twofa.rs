//! TOTP (RFC 6238) helpers for optional, per-user dashboard 2FA.
//!
//! Secrets are stored base32-encoded in `dashboard_users.totp_secret`. Recovery
//! codes are generated here but hashed (Argon2) before storage by the DB layer.

use anyhow::{anyhow, Result};
use rand::Rng;
use totp_rs::{Algorithm, Secret, TOTP};

const ISSUER: &str = "Vantyr";

fn build(secret_b32: &str, account: &str) -> Result<TOTP> {
    let bytes = Secret::Encoded(secret_b32.to_string())
        .to_bytes()
        .map_err(|e| anyhow!("invalid TOTP secret: {e:?}"))?;
    TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        bytes,
        Some(ISSUER.to_string()),
        account.to_string(),
    )
    .map_err(|e| anyhow!("TOTP build failed: {e}"))
}

/// Generate a fresh base32 secret plus its `otpauth://` provisioning URI.
pub fn generate_secret(account: &str) -> Result<(String, String)> {
    let mut raw = [0u8; 20];
    rand::thread_rng().fill(&mut raw[..]);
    let secret_b32 = Secret::Raw(raw.to_vec()).to_encoded().to_string();
    let totp = build(&secret_b32, account)?;
    let uri = totp.get_url();
    Ok((secret_b32, uri))
}

/// Verify a 6-digit code against a stored base32 secret (±1 time-step skew).
pub fn verify(secret_b32: &str, code: &str) -> bool {
    let code = code.trim();
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    match build(secret_b32, "vantyr") {
        Ok(totp) => totp.check_current(code).unwrap_or(false),
        Err(_) => false,
    }
}

/// Generate `n` human-friendly single-use recovery codes (e.g. `abcd-efgh`).
pub fn generate_recovery_codes(n: usize) -> Vec<String> {
    // Unambiguous alphabet (no l/1/o/0).
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
    let mut rng = rand::thread_rng();
    let part = |rng: &mut rand::rngs::ThreadRng| -> String {
        (0..4)
            .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
            .collect()
    };
    (0..n)
        .map(|_| format!("{}-{}", part(&mut rng), part(&mut rng)))
        .collect()
}
