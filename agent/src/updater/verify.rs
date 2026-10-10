//! Minisign verification of downloaded update MSIs against the embedded updater key.

use anyhow::{Context, Result};
use base64::Engine;
use minisign_verify::{PublicKey, Signature};

const UPDATER_PUBKEY_B64: &str =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDkwNkVDQzFDMjkzRjVEN0QKUldSOVhUOHBITXh1a003RnZYUUhqNmdsRkZTMktrbnFnZGRMZUFnaGYwNmxqV0tyL2h3bTlCUkYK";

/// `tauri.conf.json` `pubkey` may be either (a) base64 of the raw 42-byte minisign key, or
/// (b) base64 of the full UTF-8 `.pub` file (`untrusted comment` + key line). Accept both.
fn parse_embedded_public_key() -> Result<PublicKey> {
    let s = UPDATER_PUBKEY_B64.trim();
    if let Ok(pk) = PublicKey::from_base64(s) {
        return Ok(pk);
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(s)
        .context("embedded pubkey: not valid base64")?;
    let text = String::from_utf8(bytes).context("embedded pubkey: base64 is not UTF-8 text")?;
    PublicKey::decode(text.trim())
        .map_err(|e| anyhow::anyhow!("embedded pubkey: not a valid minisign .pub body: {e}"))
}

fn decode_signature(sig: &str) -> Result<Signature> {
    let mut s = sig.trim().to_string();
    // Some `latest.json` generators store literal `\n` instead of newlines.
    if !s.contains('\n') && s.contains("\\n") {
        s = s.replace("\\n", "\n");
    }
    let st = s.trim();
    if st.contains("untrusted comment") || st.contains('\n') {
        return Signature::decode(st).map_err(|e| anyhow::anyhow!("minisign signature: {e}"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(st)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(st))
        .map_err(|_| anyhow::anyhow!("signature was not valid base64 and not minisign text"))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| anyhow::anyhow!("decoded signature was not valid UTF-8"))?;
    Signature::decode(text.trim()).map_err(|e| anyhow::anyhow!("minisign signature: {e}"))
}

pub fn verify_msi_signature(msi_bytes: &[u8], signature: &str) -> Result<()> {
    let pk = parse_embedded_public_key()?;
    let sig = decode_signature(signature)?;
    // Tauri bundles use prehashed (BLAKE2b) minisign signatures for large artifacts.
    pk.verify(msi_bytes, &sig, false)
        .map_err(|e| anyhow::anyhow!("signature verify failed: {e}"))?;
    Ok(())
}
