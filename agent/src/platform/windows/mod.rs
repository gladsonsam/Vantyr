//! Windows platform backend.
//!
//! These modules are thin delegates to the current Windows implementation. The
//! point of this layer is to move call sites first, then let future Linux
//! commits fill equivalent backends behind the same names.

pub mod activity_tracker {
    #[allow(unused_imports)]
    pub use crate::window_tracker::{WindowEvent, WindowTracker};

    pub fn app_icon_png_for_path(path: &str, size: u32) -> anyhow::Result<Vec<u8>> {
        match crate::win_icons::icon_png_from_exe_path(path, size) {
            Ok(png) => Ok(png),
            Err(e) if crate::win_icons::is_current_process_exe(path) => {
                crate::win_icons::vantyr_brand_icon_png()
            }
            Err(e) => Err(e),
        }
    }
}

pub mod config_store {
    #[allow(unused_imports)]
    pub use crate::config::{
        config_path, load_config, save_config, take_reopen_settings_ui_after_restart, Config,
    };
}

pub mod desktop_capture {
    pub use crate::capture::{start_capture, CaptureSettings};
}

pub mod input_control {
    pub use crate::input::InputController;
}

pub mod keyboard_monitor {
    pub use crate::keyboard_capture::InputEvent;

    pub fn start(out_tx: tokio::sync::mpsc::Sender<InputEvent>) -> anyhow::Result<()> {
        crate::keyboard_capture::start(out_tx)
    }
}

pub mod network_policy {
    pub use crate::network_policy::{apply_block, parse_server_host_port, remove_block};
}

pub mod script_execution {
    #[allow(unused_imports)]
    pub use crate::remote_script::{run, RunOutcome};
}

pub mod software_inventory {
    pub use crate::software_inventory::{
        cmp_str_ascii_case_insensitive, send_inventory, send_inventory_if_changed,
    };
}

pub mod system_control {
    use anyhow::{anyhow, Result};
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    fn run_hidden(program: &str, args: &[&str]) -> Result<()> {
        let status = std::process::Command::new(program)
            .creation_flags(CREATE_NO_WINDOW)
            .args(args)
            .status()
            .map_err(|e| anyhow!("failed to execute {program}: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(anyhow!("{program} exited with status {status}"))
        }
    }

    pub fn lock_host() -> Result<()> {
        run_hidden("rundll32.exe", &["user32.dll,LockWorkStation"])
    }

    pub fn restart_host() -> Result<()> {
        run_hidden("shutdown", &["/r", "/t", "0", "/f"])
    }

    pub fn shutdown_host() -> Result<()> {
        run_hidden("shutdown", &["/s", "/t", "0", "/f"])
    }
}

pub mod system_info {
    pub use crate::system_info::{
        active_username, collect_agent_info, collect_resource_metrics, env_username_fallback,
    };
}

pub mod terminal {
    pub use crate::terminal::{close, input, resize, start};
}

pub mod url_provider {
    pub type ActiveUrl = browser_url::BrowserInfo;

    pub fn active_url() -> Option<ActiveUrl> {
        crate::url_scraper::get_active_url()
    }
}
