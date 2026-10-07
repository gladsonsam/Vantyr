//! UI password lock and the password-gated exit.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::OnceLock;

use argon2::password_hash::{rand_core::OsRng, PasswordHasher, SaltString};
use argon2::{Argon2, PasswordHash, PasswordVerifier};
use tauri::State;

use crate::host::ui::StoredConfig;

pub(super) static LAST_UI_AUTH_OK_AT: OnceLock<AtomicI64> = OnceLock::new();

/// Argon2 PHC string for a **new** local UI password set in the Tauri settings UI.
/// Matches the server’s `hash_dashboard_password` / `hash_agent_local_ui_password` defaults.
pub(super) fn hash_ui_password_argon2(plain: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(plain.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn has_ui_password(stored: State<StoredConfig>) -> bool {
    let cfg = stored.0.lock().unwrap_or_else(|e| e.into_inner());
    let h = cfg.ui_password_hash.as_str();
    !h.is_empty() && h.starts_with("$argon2")
}
#[tauri::command]
pub fn verify_ui_password(password: String, stored: State<StoredConfig>) -> Result<(), String> {
    let cfg = stored.0.lock().unwrap_or_else(|e| e.into_inner());
    let expected = cfg.ui_password_hash.as_str();
    if expected.is_empty() {
        // No lock configured.
        LAST_UI_AUTH_OK_AT
            .get_or_init(|| AtomicI64::new(0))
            .store(crate::unix_timestamp_secs() as i64, Ordering::Relaxed);
        return Ok(());
    }
    let Ok(parsed) = PasswordHash::new(expected) else {
        return Err("Invalid stored password hash".into());
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .map_err(|_| "Wrong password".to_string())?;
    LAST_UI_AUTH_OK_AT
        .get_or_init(|| AtomicI64::new(0))
        .store(crate::unix_timestamp_secs() as i64, Ordering::Relaxed);
    Ok(())
}
#[tauri::command]
pub fn exit_agent(stored: State<StoredConfig>) -> Result<(), String> {
    // If a UI password is set, require a recent successful verification.
    let cfg = stored.0.lock().unwrap_or_else(|e| e.into_inner());
    let expected = cfg.ui_password_hash.as_str();
    let has_pw = !expected.is_empty() && expected.starts_with("$argon2");
    drop(cfg);

    if has_pw {
        let now = crate::unix_timestamp_secs() as i64;
        let last = LAST_UI_AUTH_OK_AT
            .get_or_init(|| AtomicI64::new(0))
            .load(Ordering::Relaxed);
        // Tight window: quitting is sensitive; require a fresh auth.
        if last <= 0 || (now - last).abs() > 60 {
            return Err("Authentication required to exit".into());
        }
    }
    std::process::exit(0);
}
