//! Validated device-owned grants and centralized command authorization.
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Module {
    KeyboardText,
    IdleActivity,
    WindowActivity,
    BrowserUrls,
    Recall,
    LiveScreen,
    LiveAudio,
    RemoteInput,
    Clipboard,
    Files,
    Terminal,
    Scripts,
    SoftwareInventory,
    ResourceMetrics,
    SystemInfo,
    SystemControl,
    AppPolicy,
    NetworkPolicy,
    Logs,
}
pub const DISABLE_RETRY_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(5);

pub const MODULES: &[Module] = &[
    Module::KeyboardText,
    Module::IdleActivity,
    Module::WindowActivity,
    Module::BrowserUrls,
    Module::Recall,
    Module::LiveScreen,
    Module::LiveAudio,
    Module::RemoteInput,
    Module::Clipboard,
    Module::Files,
    Module::Terminal,
    Module::Scripts,
    Module::SoftwareInventory,
    Module::ResourceMetrics,
    Module::SystemInfo,
    Module::SystemControl,
    Module::AppPolicy,
    Module::NetworkPolicy,
    Module::Logs,
];
impl Module {
    pub fn key(self) -> String {
        serde_json::to_value(self)
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned()
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModuleState {
    pub module: Module,
    pub available: bool,
    pub enabled: bool,
    pub revision: u64,
    pub authorization_required: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModuleReport {
    #[serde(rename = "type")]
    pub kind: String,
    pub schema_version: u32,
    pub revision: u64,
    pub modules: Vec<ModuleState>,
}
impl ModuleReport {
    pub fn parse(value: serde_json::Value) -> anyhow::Result<Self> {
        let mut report: Self = serde_json::from_value(value)?;
        anyhow::ensure!(
            report.kind == "module_states" && report.schema_version == 1,
            "unsupported module report schema"
        );
        // Older agents report the complete original set. Only clipboard may be
        // omitted; synthesize an unavailable grant, never infer authorization.
        if report.modules.len() == MODULES.len() - 1
            && !report.modules.iter().any(|m| m.module == Module::Clipboard)
        {
            report.modules.push(ModuleState {
                module: Module::Clipboard,
                available: false,
                enabled: false,
                revision: 0,
                authorization_required: true,
            });
        }
        anyhow::ensure!(
            report.modules.len() == MODULES.len(),
            "report must contain all modules"
        );
        let mut seen = HashSet::new();
        for module in &report.modules {
            anyhow::ensure!(seen.insert(module.module), "duplicate module");
            anyhow::ensure!(
                module.revision <= report.revision,
                "module revision exceeds report revision"
            );
            anyhow::ensure!(
                !module.enabled || (module.available && !module.authorization_required),
                "inconsistent grant"
            );
            anyhow::ensure!(
                !module.available || module.authorization_required == !module.enabled,
                "inconsistent authorization_required"
            );
        }
        Ok(report)
    }
    pub fn get(&self, module: Module) -> &ModuleState {
        self.modules
            .iter()
            .find(|state| state.module == module)
            .expect("validated complete report")
    }
    pub fn follows(&self, previous: &Self) -> bool {
        self.revision >= previous.revision
            && self.modules.iter().all(|current| {
                let old = previous.get(current.module);
                current.revision >= old.revision
                    && (current.revision != old.revision
                        || current.authorization_required == old.authorization_required)
                    && (self.revision != previous.revision || current.revision == old.revision)
            })
    }
}
#[derive(Debug)]
pub struct RuntimeModules {
    pub conn_id: Uuid,
    pub report: ModuleReport,
    pub pending: HashMap<Uuid, crate::db::ModuleDisableRequest>,
    pub sent: HashSet<Uuid>,
    pub last_sent: HashMap<Uuid, std::time::Instant>,
}
#[derive(Debug, Clone, Serialize)]
pub struct CommandDenied {
    pub code: &'static str,
    pub error: String,
    pub module: Option<Module>,
}
impl std::fmt::Display for CommandDenied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.error)
    }
}
impl std::error::Error for CommandDenied {}
impl CommandDenied {
    pub fn new(code: &'static str, error: &str, module: Option<Module>) -> Self {
        Self {
            code,
            error: error.into(),
            module,
        }
    }
    pub fn response(self) -> axum::response::Response {
        use axum::response::IntoResponse;
        let status = if self.code == "agent_offline"
            || self.code.starts_with("capture_")
            || self.code == "invalid_monitor"
        {
            axum::http::StatusCode::CONFLICT
        } else if self.code == "command_queue_full" {
            axum::http::StatusCode::SERVICE_UNAVAILABLE
        } else {
            axum::http::StatusCode::FORBIDDEN
        };
        (status, axum::Json(self)).into_response()
    }
}
pub fn command_module(kind: &str) -> Option<Module> {
    Some(match kind {
        "start_capture" => Module::LiveScreen,
        "start_audio" => Module::LiveAudio,
        "ClipboardRead" | "ClipboardWrite" => Module::Clipboard,
        "MouseMove" | "MouseClick" | "MouseDoubleClick" | "MouseDown" | "MouseUp"
        | "MouseScroll" | "Scroll" | "KeyDown" | "KeyUp" | "KeyPress" | "KeyChar" | "TypeText"
        | "Notify" => Module::RemoteInput,
        "TerminalStart" | "TerminalInput" | "TerminalResize" => Module::Terminal,
        "RunScript" => Module::Scripts,
        "ListDir" | "ReadFile" | "WriteFileChunk" | "Mkdir" | "RenamePath" | "DeletePath"
        | "CopyPath" => Module::Files,
        "CollectSoftware" => Module::SoftwareInventory,
        "RequestInfo" => Module::SystemInfo,
        "LockHost" | "RestartHost" | "ShutdownHost" => Module::SystemControl,
        "set_app_block_rules" => Module::AppPolicy,
        "set_network_policy" | "set_internet_block_rules" => Module::NetworkPolicy,
        "ListLogSources" | "ReadLogTail" => Module::Logs,
        _ => return None,
    })
}
pub fn protocol_command(kind: &str) -> bool {
    matches!(
        kind,
        "ClipboardCancel"
            | "stop_capture"
            | "stop_audio"
            | "TerminalClose"
            | "set_recall_settings"
            | "set_auto_update"
            | "update_now"
            | "agent_deleted"
            | "agent_credentials_revoked"
            | "history_frame_ack"
    )
}
impl AppState {
    pub fn module_authorized(&self, id: Uuid, module: Module) -> bool {
        let agents = self.agents.lock();
        let modules = self.agent_modules.lock();
        agents
            .get(&id)
            .zip(modules.get(&id))
            .is_some_and(|(conn, runtime)| {
                let grant = runtime.report.get(module);
                conn.conn_id == runtime.conn_id
                    && grant.available
                    && grant.enabled
                    && !grant.authorization_required
                    && !runtime
                        .pending
                        .values()
                        .any(|request| request.module == module)
            })
    }
    pub fn recall_context_grants(
        &self,
        id: Uuid,
        conn_id: Uuid,
    ) -> Option<(Option<u64>, Option<u64>)> {
        let agents = self.agents.lock();
        let modules = self.agent_modules.lock();
        let (connection, runtime) = agents.get(&id).zip(modules.get(&id))?;
        if connection.conn_id != conn_id || runtime.conn_id != conn_id {
            return None;
        }
        let revision = |module| {
            let grant = runtime.report.get(module);
            (grant.available
                && grant.enabled
                && !grant.authorization_required
                && !runtime
                    .pending
                    .values()
                    .any(|request| request.module == module))
            .then_some(grant.revision)
        };
        revision(Module::Recall)?;
        Some((
            revision(Module::WindowActivity),
            revision(Module::BrowserUrls),
        ))
    }
    /// Last persisted reports are for display only. Authorization uses the current
    /// connection's validated runtime report, never versions or stored history.
    pub fn authorize_agent_command(
        &self,
        agent_id: Uuid,
        cmd: &serde_json::Value,
    ) -> Result<serde_json::Value, CommandDenied> {
        let agents = self.agents.lock();
        let connection = agents
            .get(&agent_id)
            .ok_or_else(|| CommandDenied::new("agent_offline", "Agent is not connected.", None))?;
        let kind = cmd["type"].as_str().unwrap_or("");
        let mut command = cmd.clone();
        if command.get("__module_generation").is_some()
            || command.get("__capture_generation").is_some()
        {
            return Err(CommandDenied::new(
                "invalid_command",
                "Server-owned generation field is not accepted from callers.",
                None,
            ));
        }
        if protocol_command(kind) {
            return Ok(command);
        }
        let modules = self.agent_modules.lock();
        let runtime = modules
            .get(&agent_id)
            .filter(|runtime| runtime.conn_id == connection.conn_id);
        if kind == "disable_module" {
            let runtime = runtime.ok_or_else(|| CommandDenied::new("module_report_required", "Update the agent and authorize modules on the device; a current report is required.", None))?;
            let id = cmd["command_id"]
                .as_str()
                .and_then(|id| Uuid::parse_str(id).ok());
            let request = id.and_then(|id| runtime.pending.get(&id)).ok_or_else(|| {
                CommandDenied::new(
                    "invalid_disable_request",
                    "Disable commands must come from a persisted request.",
                    None,
                )
            })?;
            if cmd["module"] != serde_json::to_value(request.module).unwrap()
                || cmd["expected_revision"].as_u64() != Some(request.expected_revision)
            {
                return Err(CommandDenied::new(
                    "invalid_disable_request",
                    "Disable request binding differs from its persisted command.",
                    None,
                ));
            }
            return Ok(command);
        }
        let module = command_module(kind).ok_or_else(|| {
            CommandDenied::new(
                "unsupported_command",
                "This command is not supported. Configure device-owned settings on the device.",
                None,
            )
        })?;
        // Agents that predate module reports cannot grant policy modules; keep
        // their old unconditional policy delivery. Once any report has been
        // persisted for the device, a current report is always required.
        if runtime.is_none()
            && connection.legacy_policy_delivery
            && matches!(module, Module::AppPolicy | Module::NetworkPolicy)
        {
            return Ok(command);
        }
        let runtime = runtime.ok_or_else(|| CommandDenied::new("module_report_required", "Update the agent and authorize this module on the device; no current module report is available.", Some(module)))?;
        let grant = runtime.report.get(module);
        if !grant.available || !grant.enabled || grant.authorization_required {
            return Err(CommandDenied::new(
                "module_not_authorized",
                "This module must be available and authorized locally on the device.",
                Some(module),
            ));
        }
        if runtime
            .pending
            .values()
            .any(|request| request.module == module)
        {
            return Err(CommandDenied::new(
                "module_disable_pending",
                "A persisted disable request is awaiting acknowledgment; commands are blocked.",
                Some(module),
            ));
        }
        command["__module_generation"] =
            serde_json::json!({ "module": module, "revision": grant.revision });
        Ok(command)
    }
    pub fn send_agent_command_json(
        &self,
        agent_id: Uuid,
        cmd: &serde_json::Value,
    ) -> Result<(), CommandDenied> {
        let conn_id = self.agents.lock().get(&agent_id).map(|conn| conn.conn_id);
        let command = self.authorize_agent_command(agent_id, cmd)?;
        if matches!(cmd["type"].as_str(), Some("start_capture" | "stop_capture")) {
            return Err(CommandDenied::new(
                "capture_session_required",
                "Capture selection is managed by live stream sessions.",
                Some(Module::LiveScreen),
            ));
        }
        if crate::control_runtime::is_remote_input(cmd["type"].as_str().unwrap_or(""))
            || matches!(
                cmd["type"].as_str(),
                Some("ClipboardRead" | "ClipboardWrite")
            )
        {
            return Err(CommandDenied::new(
                "control_lease_required",
                "Remote input requires a viewer control lease.",
                Some(Module::RemoteInput),
            ));
        }
        self.enqueue_authorized_command(
            agent_id,
            conn_id.ok_or_else(|| {
                CommandDenied::new("agent_offline", "Agent is not connected.", None)
            })?,
            command,
        )
    }
    pub(crate) fn enqueue_authorized_command(
        &self,
        agent_id: Uuid,
        conn_id: Uuid,
        command: serde_json::Value,
    ) -> Result<(), CommandDenied> {
        let agents = self.agents.lock();
        if !agents
            .get(&agent_id)
            .is_some_and(|conn| conn.conn_id == conn_id && conn.shutdown.borrow().is_none())
        {
            return Err(CommandDenied::new(
                "agent_offline",
                "Connection changed or is closing.",
                None,
            ));
        }
        self.agent_cmds
            .lock()
            .get(&agent_id)
            .ok_or_else(|| CommandDenied::new("agent_offline", "Agent is not connected.", None))?
            .try_send(crate::state::AgentControl::Text(command.to_string()))
            .map_err(|_| {
                CommandDenied::new(
                    "command_queue_full",
                    "Agent command queue is full; retry shortly.",
                    None,
                )
            })
    }
    /// Re-check queued commands at delivery. A local regrant must not resurrect
    /// work queued under an earlier permission generation or socket.
    pub fn command_deliverable(
        &self,
        agent_id: Uuid,
        conn_id: Uuid,
        cmd: &serde_json::Value,
    ) -> bool {
        let mut control = self.control.lock();
        if matches!(
            cmd["type"].as_str(),
            Some("ClipboardRead" | "ClipboardWrite")
        ) && !self.clipboard_deliverable_locked(&mut control, agent_id, conn_id, cmd)
        {
            return false;
        }
        if self
            .agents
            .lock()
            .get(&agent_id)
            .filter(|connection| connection.shutdown.borrow().is_none())
            .map(|connection| connection.conn_id)
            != Some(conn_id)
        {
            return false;
        }
        let mut untagged = cmd.clone();
        let capture = untagged
            .as_object_mut()
            .and_then(|object| object.remove("__capture_generation"));
        if matches!(cmd["type"].as_str(), Some("start_capture" | "stop_capture")) {
            let active = self
                .media
                .mjpeg_active_capture
                .lock()
                .get(&agent_id)
                .copied();
            let expected = if cmd["type"] == "start_capture" {
                active
                    .filter(|a| a.conn_id == conn_id)
                    .map(|a| serde_json::json!(a.generation))
            } else if active.is_none() {
                Some(serde_json::json!("stopped"))
            } else {
                None
            };
            if capture.is_none() || capture != expected {
                return false;
            }
        } else if capture.is_some() {
            return false;
        }
        let generation = untagged
            .as_object_mut()
            .and_then(|object| object.remove("__module_generation"));
        match self.authorize_agent_command(agent_id, &untagged) {
            Ok(expected) => generation == expected.get("__module_generation").cloned(),
            Err(_) => false,
        }
    }
}

#[derive(Debug, Deserialize)]
struct DisableAck {
    #[serde(rename = "type")]
    kind: String,
    command_id: Uuid,
    module: Module,
    ok: bool,
    status: String,
    #[serde(default)]
    state: Option<serde_json::Value>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    persisted: bool,
    #[serde(default)]
    stopped: bool,
    #[serde(default)]
    stop_status: Option<String>,
}
impl AppState {
    /// The caller must retain the current socket's ingestion lease through all DB writes.
    pub async fn accept_module_report(
        &self,
        agent_id: Uuid,
        conn_id: Uuid,
        value: serde_json::Value,
        _lease: &crate::state::agent_lifecycle::IngestionLease,
    ) -> anyhow::Result<()> {
        let report = ModuleReport::parse(value)?;
        anyhow::ensure!(
            self.agents
                .lock()
                .get(&agent_id)
                .map(|connection| connection.conn_id)
                == Some(conn_id),
            "stale socket report"
        );
        {
            let runtime = self.agent_modules.lock();
            if let Some(previous) = runtime
                .get(&agent_id)
                .filter(|runtime| runtime.conn_id == conn_id)
            {
                anyhow::ensure!(
                    report.follows(&previous.report),
                    "backward or inconsistent module revisions"
                );
            }
        }
        let pending = crate::db::module_disable_requests(&self.db, agent_id, true).await?;
        crate::db::save_module_report(&self.db, agent_id, conn_id, &report).await?;
        {
            let mut control = self.control.lock();
            let grant = report.get(Module::RemoteInput);
            let screen = report.get(Module::LiveScreen);
            let screen_changed =
                self.agent_modules.lock().get(&agent_id).is_some_and(|old| {
                    old.report.get(Module::LiveScreen).revision != screen.revision
                });
            let revoke = screen_changed
                || !screen.enabled
                || !screen.available
                || screen.authorization_required
                || !grant.enabled
                || !grant.available
                || grant.authorization_required
                || pending
                    .iter()
                    .any(|request| request.module == Module::RemoteInput)
                || self.agent_modules.lock().get(&agent_id).is_some_and(|old| {
                    old.report.get(Module::RemoteInput).revision != grant.revision
                });
            if revoke {
                self.revoke_agent_control_locked(&mut control, agent_id, conn_id);
            }
            if screen_changed {
                if let Some(active) = self.media.mjpeg_active_capture.lock().get_mut(&agent_id) {
                    active.generation = Uuid::nil();
                }
            }
            let mut runtime = self.agent_modules.lock();
            let (sent, last_sent) = runtime
                .remove(&agent_id)
                .filter(|runtime| runtime.conn_id == conn_id)
                .map(|runtime| (runtime.sent, runtime.last_sent))
                .unwrap_or_default();
            runtime.insert(
                agent_id,
                RuntimeModules {
                    conn_id,
                    report: report.clone(),
                    pending: pending
                        .into_iter()
                        .map(|request| (request.command_id, request))
                        .collect(),
                    sent,
                    last_sent,
                },
            );
        }
        self.broadcast(serde_json::json!({"event":"agent_modules","agent_id":agent_id,"state":report,"reported_at":chrono::Utc::now()}).to_string());
        self.replay_module_disables(agent_id, conn_id).await?;
        Ok(())
    }
    /// Once per connection/request, plus explicit operator HTTP retry.
    /// No timer and no repeated sends on periodic identical reports.
    pub async fn replay_module_disables(
        &self,
        agent_id: Uuid,
        conn_id: Uuid,
    ) -> anyhow::Result<()> {
        let requests: Vec<_> = self
            .agent_modules
            .lock()
            .get(&agent_id)
            .filter(|runtime| runtime.conn_id == conn_id)
            .map(|runtime| {
                runtime
                    .pending
                    .values()
                    .filter(|request| !runtime.sent.contains(&request.command_id))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        for request in requests {
            let cmd = serde_json::json!({"type":"disable_module","module":request.module,"expected_revision":request.expected_revision,"command_id":request.command_id});
            if self.send_agent_command_json(agent_id, &cmd).is_ok() {
                if let Some(runtime) = self
                    .agent_modules
                    .lock()
                    .get_mut(&agent_id)
                    .filter(|runtime| runtime.conn_id == conn_id)
                {
                    runtime.sent.insert(request.command_id);
                    runtime
                        .last_sent
                        .insert(request.command_id, std::time::Instant::now());
                }
                crate::db::mark_module_disable_sent(
                    &self.db,
                    agent_id,
                    request.command_id,
                    conn_id,
                )
                .await?;
            }
        }
        Ok(())
    }
    /// The same ingestion lease prevents credential rotation during persistence.
    pub async fn accept_module_disable_ack(
        &self,
        agent_id: Uuid,
        conn_id: Uuid,
        value: serde_json::Value,
        _lease: &crate::state::agent_lifecycle::IngestionLease,
    ) -> anyhow::Result<()> {
        let ack: DisableAck = serde_json::from_value(value)?;
        anyhow::ensure!(
            ack.kind == "module_disable_ack",
            "invalid acknowledgment type"
        );
        anyhow::ensure!(
            self.agents
                .lock()
                .get(&agent_id)
                .map(|connection| connection.conn_id)
                == Some(conn_id),
            "stale socket acknowledgment"
        );
        let request = crate::db::module_disable_request(&self.db, agent_id, ack.command_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("uncorrelated acknowledgment"))?;
        if !request.pending {
            return Ok(());
        } // Terminal results are immutable.
        anyhow::ensure!(
            self.agent_modules
                .lock()
                .get(&agent_id)
                .filter(|runtime| runtime.conn_id == conn_id)
                .is_some_and(|runtime| runtime.sent.contains(&ack.command_id)),
            "acknowledgment was not sent on this connection"
        );
        anyhow::ensure!(
            request.module == ack.module,
            "acknowledgment module differs from request"
        );
        let success = matches!(ack.status.as_str(), "disabled" | "duplicate");
        anyhow::ensure!(
            matches!(
                ack.status.as_str(),
                "disabled" | "duplicate" | "stale" | "conflict" | "error"
            ) && ack.ok == success,
            "invalid acknowledgment status"
        );
        anyhow::ensure!(
            !success || ack.persisted,
            "successful ack must confirm durable persistence"
        );
        anyhow::ensure!(
            !ack.stopped,
            "physical stop is not confirmed by this protocol"
        );
        let stop_status = ack.stop_status.as_deref().unwrap_or("unconfirmed");
        anyhow::ensure!(stop_status.len() <= 256, "invalid stop status");
        let report = ack.state.map(ModuleReport::parse).transpose()?;
        anyhow::ensure!(
            ack.status == "error" || report.is_some(),
            "acknowledgment needs full report"
        );
        if let Some(report) = &report {
            let grant = report.get(ack.module);
            if success {
                anyhow::ensure!(
                    grant.revision > request.expected_revision,
                    "ack revision does not follow requested generation"
                );
            }
            if ack.status == "disabled" {
                anyhow::ensure!(
                    !grant.enabled && grant.authorization_required,
                    "disable ack must report revoked grant"
                );
            }
            if ack.status == "stale" {
                anyhow::ensure!(
                    grant.revision != request.expected_revision,
                    "stale ack must show different generation"
                );
            }
            if let Some(previous) = self
                .agent_modules
                .lock()
                .get(&agent_id)
                .filter(|runtime| runtime.conn_id == conn_id)
            {
                anyhow::ensure!(
                    report.follows(&previous.report),
                    "backward acknowledgment report"
                );
            }
        }
        // Validate the entire ack before either the report or request is updated.
        if let Some(report) = &report {
            crate::db::save_module_report(&self.db, agent_id, conn_id, report).await?;
        }
        let error = ack
            .error
            .as_ref()
            .map(|error| error.chars().take(1024).collect::<String>());
        if request.pending {
            crate::db::acknowledge_module_disable(
                &self.db,
                agent_id,
                ack.command_id,
                &ack.status,
                error.as_deref(),
                stop_status,
            )
            .await?;
        }
        {
            let mut control = self.control.lock();
            let screen_changed = report.as_ref().is_some_and(|report| {
                self.agent_modules.lock().get(&agent_id).is_some_and(|old| {
                    old.report.get(Module::LiveScreen).revision
                        != report.get(Module::LiveScreen).revision
                })
            });
            let revoke = screen_changed
                || report.as_ref().is_some_and(|report| {
                    let new = report.get(Module::RemoteInput);
                    let screen = report.get(Module::LiveScreen);
                    !screen.enabled
                        || !screen.available
                        || screen.authorization_required
                        || !new.enabled
                        || !new.available
                        || new.authorization_required
                        || self.agent_modules.lock().get(&agent_id).is_some_and(|old| {
                            old.report.get(Module::RemoteInput).revision != new.revision
                        })
                });
            if revoke {
                self.revoke_agent_control_locked(&mut control, agent_id, conn_id);
            }
            if screen_changed {
                if let Some(active) = self.media.mjpeg_active_capture.lock().get_mut(&agent_id) {
                    active.generation = Uuid::nil();
                }
            }
            let mut runtime = self.agent_modules.lock();
            if let Some(runtime) = runtime
                .get_mut(&agent_id)
                .filter(|runtime| runtime.conn_id == conn_id)
            {
                if let Some(report) = &report {
                    runtime.report = report.clone();
                }
                runtime.pending.remove(&ack.command_id);
                runtime.sent.remove(&ack.command_id);
                runtime.last_sent.remove(&ack.command_id);
            }
        }
        self.broadcast(serde_json::json!({"event":"module_disable_ack","agent_id":agent_id,"command_id":ack.command_id,"module":ack.module,"status":ack.status,"persisted":success,"stopped":false,"stop_status":stop_status,"error":error,"state":report}).to_string());
        Ok(())
    }
}

#[cfg(test)]
#[path = "agent_modules_tests.rs"]
mod tests;
