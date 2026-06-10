//! Agent enrollment: create a pending claim, poll for admin approval, then store the issued token.

#[cfg(target_os = "windows")]
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::time::Duration;

#[cfg(target_os = "windows")]
use serde::Deserialize;
#[cfg(target_os = "windows")]
use tracing::{info, warn};

use crate::config::Config;

#[cfg(target_os = "windows")]
#[derive(Debug, Deserialize)]
struct EnrollJson {
    #[serde(default)]
    #[serde(alias = "enrollment_token", alias = "pairing_code")]
    enrollment_token: String,
    server_url: String,
    #[serde(default)]
    agent_name: Option<String>,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Deserialize)]
struct ClaimCreateResponse {
    claim_id: String,
    #[serde(default)]
    poll_after_secs: Option<u64>,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Deserialize)]
struct ClaimPollResponse {
    status: String,
    #[serde(default)]
    poll_after_secs: Option<u64>,
    #[serde(default)]
    agent_token: Option<String>,
    #[serde(default)]
    agent_name: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[cfg(target_os = "windows")]
fn enroll_json_path() -> PathBuf {
    std::env::var_os("ProgramData")
        .map_or_else(|| PathBuf::from(r"C:\ProgramData"), PathBuf::from)
        .join("Vantyr")
        .join("enroll.json")
}

#[cfg(target_os = "windows")]
pub fn wss_to_enrollment_claims_url(wss: &str) -> Option<String> {
    let rest = wss.trim().strip_prefix("wss://")?;
    let authority = rest.split('/').next().unwrap_or(rest);
    if authority.is_empty() {
        return None;
    }
    Some(format!("https://{authority}/api/agent/enrollment/claims"))
}

#[cfg(target_os = "windows")]
fn stable_install_id(cfg: &mut Config) -> String {
    if cfg.install_id.trim().is_empty() {
        cfg.install_id = uuid::Uuid::new_v4().to_string();
    }
    cfg.install_id.clone()
}

#[cfg(target_os = "windows")]
fn windows_username() -> Option<String> {
    std::env::var("USERNAME")
        .ok()
        .filter(|s| !s.trim().is_empty())
}

#[cfg(target_os = "windows")]
fn os_label() -> String {
    let mut info = crate::system_info::collect_agent_info();
    if let serde_json::Value::Object(ref mut obj) = info {
        if let Some(v) = obj
            .get("os_version")
            .or_else(|| obj.get("os"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
        {
            return v.to_string();
        }
    }
    "Windows".to_string()
}

#[cfg(target_os = "windows")]
pub async fn adopt_with_enrollment(
    wss_url: &str,
    pairing_code: &str,
    agent_name: &str,
) -> anyhow::Result<Config> {
    request_access_and_wait(wss_url, Some(pairing_code), agent_name).await
}

#[cfg(target_os = "windows")]
async fn request_access_and_wait(
    wss_url: &str,
    pairing_code: Option<&str>,
    agent_name: &str,
) -> anyhow::Result<Config> {
    let claims_url = wss_to_enrollment_claims_url(wss_url)
        .ok_or_else(|| anyhow::anyhow!("Server URL must start with wss://"))?;

    let mut cfg = crate::config::load_config();
    let install_id = stable_install_id(&mut cfg);
    let requested_name = agent_name.trim();
    cfg.server_url = wss_url.trim().to_string();
    cfg.agent_name = requested_name.to_string();

    // Persist the generated install_id before approval so repeated startup
    // attempts update the same pending claim instead of creating duplicates.
    crate::config::write_machine_policy_dat(&cfg)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;

    let create_resp = client
        .post(&claims_url)
        .json(&serde_json::json!({
            "pairing_code": pairing_code.map(str::trim).filter(|s| !s.is_empty()),
            "requested_name": requested_name,
            "hostname": std::env::var("COMPUTERNAME").ok(),
            "windows_username": windows_username(),
            "os": os_label(),
            "agent_version": env!("CARGO_PKG_VERSION"),
            "install_id": install_id,
            "discovered_server": wss_url.trim(),
        }))
        .send()
        .await?;

    let status = create_resp.status();
    let body_text = create_resp.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!(
            "Pairing request failed HTTP {}: {body_text}",
            status.as_u16()
        );
    }
    let created: ClaimCreateResponse = serde_json::from_str(&body_text)
        .map_err(|e| anyhow::anyhow!("Invalid JSON from server: {e}; body={body_text:?}"))?;

    let poll_url = format!("{claims_url}/{}", created.claim_id);
    let mut wait = created.poll_after_secs.unwrap_or(2).clamp(1, 10);
    for _ in 0..300 {
        tokio::time::sleep(Duration::from_secs(wait)).await;
        let resp = client.get(&poll_url).send().await?;
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!("Pairing poll failed HTTP {}: {body_text}", status.as_u16());
        }
        let polled: ClaimPollResponse = serde_json::from_str(&body_text)
            .map_err(|e| anyhow::anyhow!("Invalid JSON from server: {e}; body={body_text:?}"))?;
        wait = polled.poll_after_secs.unwrap_or(2).clamp(1, 10);
        match polled.status.as_str() {
            "pending" => continue,
            "approved" => {
                let agent_token = polled
                    .agent_token
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        anyhow::anyhow!(polled
                            .error
                            .unwrap_or_else(|| "Approval did not include a token".into()))
                    })?;
                cfg.server_url = wss_url.trim().to_string();
                cfg.agent_name = polled
                    .agent_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(requested_name)
                    .to_string();
                cfg.agent_token = agent_token.to_string();
                crate::config::write_machine_policy_dat(&cfg)?;
                info!("Pairing approved; machine-wide config.dat updated.");
                return Ok(cfg);
            }
            "rejected" => anyhow::bail!(
                "{}",
                polled.error.unwrap_or_else(|| "Rejected by admin".into())
            ),
            "expired" => anyhow::bail!(
                "{}",
                polled
                    .error
                    .unwrap_or_else(|| "Pairing code expired".into())
            ),
            other => anyhow::bail!("Unexpected pairing status: {other}"),
        }
    }
    anyhow::bail!("Timed out waiting for admin approval")
}

#[cfg(target_os = "windows")]
pub async fn try_auto_discover_and_request_access() -> anyhow::Result<Option<Config>> {
    let cfg = crate::config::load_config();
    if !cfg.agent_token.trim().is_empty() {
        return Ok(None);
    }

    let agent_name = cfg
        .agent_name
        .trim()
        .is_empty()
        .then(|| std::env::var("COMPUTERNAME").unwrap_or_else(|_| "agent".to_string()))
        .unwrap_or_else(|| cfg.agent_name.trim().to_string());

    let mut candidates = Vec::new();
    if cfg.server_url.trim().starts_with("wss://") {
        candidates.push(cfg.server_url.trim().to_string());
    } else {
        let discovered = crate::mdns_discover::discover_vantyr_servers(4_000);
        candidates.extend(discovered.into_iter().map(|server| server.wss_url));
    }

    if candidates.is_empty() {
        return Ok(None);
    }

    for wss_url in candidates {
        info!("Requesting Vantyr access via discovered server {wss_url}");
        match request_access_and_wait(&wss_url, None, &agent_name).await {
            Ok(cfg) => return Ok(Some(cfg)),
            Err(e) => warn!("Automatic access request via {wss_url} failed: {e:#}"),
        }
    }

    Ok(None)
}

#[cfg(not(target_os = "windows"))]
pub async fn adopt_with_enrollment(
    _wss_url: &str,
    _pairing_code: &str,
    _agent_name: &str,
) -> anyhow::Result<Config> {
    anyhow::bail!("Enrollment is only supported on Windows")
}

#[cfg(target_os = "windows")]
pub async fn try_consume_pending_enrollment() -> anyhow::Result<bool> {
    let path = enroll_json_path();
    if !path.is_file() {
        return Ok(false);
    }

    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            warn!("Could not read {}: {e}", path.display());
            return Ok(false);
        }
    };

    let file: EnrollJson = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            warn!("Invalid enroll.json ({}): {e}", path.display());
            let _ = std::fs::remove_file(&path);
            return Ok(false);
        }
    };

    let agent_name = file
        .agent_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| std::env::var("COMPUTERNAME").unwrap_or_else(|_| "agent".to_string()));

    match adopt_with_enrollment(&file.server_url, &file.enrollment_token, &agent_name).await {
        Ok(_) => {
            let _ = std::fs::remove_file(&path);
            info!("Removed enroll.json after successful pairing.");
            Ok(true)
        }
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("Rejected")
                || msg.contains("expired")
                || msg.contains("invalid or expired")
                || msg.contains("Invalid enroll.json")
            {
                warn!("{msg}; removing enroll.json");
                let _ = std::fs::remove_file(&path);
                return Ok(false);
            }
            warn!("Pairing failed (will retry after restart): {e:#}");
            Ok(false)
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub async fn try_consume_pending_enrollment() -> anyhow::Result<bool> {
    Ok(false)
}
