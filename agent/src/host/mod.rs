//! The process host: which role this process plays, and the Windows plumbing
//! around it — the Session 0 service, the IPC pipes between service and
//! companion, the client for the privileged service pipe and the settings UI —
//! plus the agent's own log files.

#[cfg(windows)]
pub mod ipc;
pub mod log_sources;
pub mod role;
#[cfg(windows)]
pub mod service;
#[cfg(windows)]
pub mod service_client;
#[cfg(windows)]
pub mod ui;
