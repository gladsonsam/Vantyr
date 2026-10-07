//! Windows platform backend.
//!
//! These modules are thin delegates to the current Windows implementation. The
//! point of this layer is to move call sites first, then let future Linux
//! commits fill equivalent backends behind the same names.

pub mod activity_tracker;
mod app_display;
mod app_icons;

pub mod desktop_capture {
    pub use crate::capture::{list_monitors, start_capture, CaptureSettings};
}

pub mod input_control {
    pub use crate::input::InputController;
}

pub mod keyboard_monitor;

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

pub mod system_control;

pub mod system_info {
    pub use crate::system_info::{
        active_username, collect_agent_info, collect_resource_metrics, env_username_fallback,
    };
}

pub mod terminal;

pub mod url_provider;
