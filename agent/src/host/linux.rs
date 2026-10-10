//! Linux host: a single standalone agent process with no service split and no
//! settings UI yet.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tracing::warn;

use super::Launch;
use crate::config::{AgentStatus, Config};

/// There is no service or capture-worker role on Linux.
pub(super) fn run_service_role(_launch: &Launch) -> bool {
    false
}

pub(super) fn prepare_interactive(_launch: &Launch) {}

/// There is no settings UI on Linux yet, so nothing to show.
pub(super) fn show_ui_on_startup(_launch: &Launch) -> bool {
    false
}

pub(super) fn log_config_state() {}

/// No settings UI on Linux yet: stay headless.
pub(super) fn run_ui(
    _initial_config: Config,
    _config_tx: tokio::sync::watch::Sender<Option<Config>>,
    _shared_cfg: Arc<Mutex<Config>>,
    _agent_status: Arc<Mutex<AgentStatus>>,
    _show_ui_on_startup: bool,
) {
    warn!("Settings UI is not available on Linux yet; running headless.");
    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}
