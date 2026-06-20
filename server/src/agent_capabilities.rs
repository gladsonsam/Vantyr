use sqlx::PgPool;
use uuid::Uuid;

use crate::db;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentPlatform {
    Windows,
    Linux,
    Other,
    Unknown,
}

pub fn capability_is_unavailable(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "unsupported" | "unavailable" | "not_supported" | "disabled"
    )
}

pub fn capability_is_attemptable(status: Option<&str>) -> bool {
    match status {
        None => true,
        Some(s) => !capability_is_unavailable(s),
    }
}

pub async fn capability_status(
    pool: &PgPool,
    agent_id: Uuid,
    capability: &str,
) -> anyhow::Result<Option<String>> {
    let Some(info) = db::get_agent_info(pool, agent_id).await? else {
        return Ok(None);
    };
    Ok(info
        .get("capabilities")
        .and_then(|caps| caps.get(capability))
        .and_then(|v| v.as_str())
        .map(str::to_string))
}

pub async fn capability_attemptable(
    pool: &PgPool,
    agent_id: Uuid,
    capability: &str,
) -> anyhow::Result<bool> {
    let status = capability_status(pool, agent_id, capability).await?;
    Ok(capability_is_attemptable(status.as_deref()))
}

pub async fn platform(pool: &PgPool, agent_id: Uuid) -> anyhow::Result<AgentPlatform> {
    let Some(info) = db::get_agent_info(pool, agent_id).await? else {
        return Ok(AgentPlatform::Unknown);
    };
    let platform = info
        .get("capabilities")
        .and_then(|caps| caps.get("platform"))
        .or_else(|| info.get("platform"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    Ok(match platform.as_str() {
        "windows" => AgentPlatform::Windows,
        "linux" => AgentPlatform::Linux,
        "" => AgentPlatform::Unknown,
        _ => AgentPlatform::Other,
    })
}

pub async fn shell_allowed(pool: &PgPool, agent_id: Uuid, shell: &str) -> anyhow::Result<bool> {
    let shell = shell.trim().to_ascii_lowercase();
    let platform = platform(pool, agent_id).await?;
    let allowed = match platform {
        AgentPlatform::Linux => matches!(shell.as_str(), "sh" | "bash"),
        AgentPlatform::Windows | AgentPlatform::Unknown => {
            matches!(shell.as_str(), "powershell" | "cmd")
        }
        AgentPlatform::Other => false,
    };
    Ok(allowed)
}

pub async fn shell_error(
    pool: &PgPool,
    agent_id: Uuid,
    shell: &str,
) -> anyhow::Result<Option<String>> {
    if shell_allowed(pool, agent_id, shell).await? {
        return Ok(None);
    }
    let expected = match platform(pool, agent_id).await? {
        AgentPlatform::Linux => "\"sh\" or \"bash\"",
        AgentPlatform::Windows | AgentPlatform::Unknown => "\"powershell\" or \"cmd\"",
        AgentPlatform::Other => "a shell supported by this agent platform",
    };
    Ok(Some(format!("shell must be {expected} for this agent")))
}
