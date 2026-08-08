//! Process role.
//!
//! The agent binary runs in one of three roles on Windows:
//!
//! * [`AgentRole::Standalone`] — the whole agent in one process (a user runs
//!   `vantyr-agent.exe` directly, no service). Captures + injects input in-process.
//! * [`AgentRole::Companion`] — launched by the Session 0 service into the
//!   interactive **user** session (`--service-managed`). Owns user-context
//!   telemetry (keystrokes, URLs, window focus, screen history) but **not** live
//!   screen capture or remote input: those belong to the capture worker, which
//!   can also reach the secure/lock-screen desktop. Suppressing them here avoids
//!   two processes capturing the same monitor.
//! * [`AgentRole::CaptureWorker`] — launched by the service as **SYSTEM** into
//!   the active console session (`--capture-worker`). Does live capture + remote
//!   input only, re-attaching to whichever desktop currently owns input
//!   (`Default` when signed in, `Winlogon` at the lock screen). See
//!   [`crate::capture_worker`].
//!
//! On Linux only [`AgentRole::Standalone`] is ever used.

use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentRole {
    Standalone = 0,
    Companion = 1,
    CaptureWorker = 2,
}

static ROLE: AtomicU8 = AtomicU8::new(AgentRole::Standalone as u8);

pub fn set_role(role: AgentRole) {
    ROLE.store(role as u8, Ordering::Relaxed);
}

pub fn role() -> AgentRole {
    match ROLE.load(Ordering::Relaxed) {
        1 => AgentRole::Companion,
        2 => AgentRole::CaptureWorker,
        _ => AgentRole::Standalone,
    }
}

/// True when this process must NOT run live screen capture or remote input,
/// because a sibling capture worker owns them. Only the [`AgentRole::Companion`]
/// suppresses them; standalone and the worker itself run them normally.
pub fn suppresses_capture_and_input() -> bool {
    role() == AgentRole::Companion
}
