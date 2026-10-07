//! Windows: the service and the user-session agent it launches log beside the
//! config under `%ProgramData%\Vantyr`.

use std::path::PathBuf;

use super::{resolve_log_kind, LogSourceDesc};

pub(super) fn service_sources() -> Vec<LogSourceDesc> {
    let pd = crate::config::program_data_vantyr_dir();
    vec![
        LogSourceDesc {
            id: "user_agent".into(),
            label: "User session started by service (user-agent.log)".into(),
            path: pd.join("user-agent.log").display().to_string(),
        },
        LogSourceDesc {
            id: "service".into(),
            label: "Windows service (service.log)".into(),
            path: pd.join("service.log").display().to_string(),
        },
    ]
}

pub(super) fn service_log(file: &str) -> Result<PathBuf, String> {
    Ok(crate::config::program_data_vantyr_dir().join(file))
}

/// [`resolve_log_kind`] without `env`: only the fixed `%ProgramData%\Vantyr`
/// logs. The SYSTEM service truncates these on the user's behalf, so it must
/// never follow a caller-influenced path such as `AGENT_LOG_FILE`.
pub fn resolve_fixed_log_kind(kind: &str) -> Result<PathBuf, String> {
    match kind {
        "local_agent" | "user_agent" | "service" => resolve_log_kind(kind),
        _ => Err(format!("unknown log source: {kind}")),
    }
}
