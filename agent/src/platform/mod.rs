//! Platform facade for agent features that need OS-specific backends.
//!
//! Windows keeps the existing service/companion implementation. Linux provides
//! direct user-session backends where the desktop, portal, or local privileges
//! allow it, and reports unsupported capabilities honestly when they do not.

#[cfg(not(target_os = "windows"))]
pub mod linux;
#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(not(target_os = "windows"))]
use self::linux as backend;
#[cfg(target_os = "windows")]
use self::windows as backend;

/// OS-neutral data types every backend produces. Defined once so the Windows
/// and Linux backends cannot diverge on shape.
pub mod types;

/// Compiler-enforced contract: forces both backends to expose the same
/// capability entry points with identical signatures (see [`contract`]).
mod contract;

pub mod activity_tracker {
    pub use super::backend::activity_tracker::*;
}

pub mod config_store {
    pub use super::backend::config_store::*;
}

pub mod desktop_capture {
    pub use super::backend::desktop_capture::*;
}

pub mod input_control {
    pub use super::backend::input_control::*;
}

pub mod keyboard_monitor {
    pub use super::backend::keyboard_monitor::*;
}

pub mod network_policy {
    pub use super::backend::network_policy::*;
}

pub mod script_execution {
    pub use super::backend::script_execution::*;
}

pub mod software_inventory {
    pub use super::backend::software_inventory::*;
}

pub mod system_control {
    pub use super::backend::system_control::*;
}

pub mod system_info {
    pub use super::backend::system_info::*;
}

pub mod terminal {
    pub use super::backend::terminal::*;
}

pub mod url_provider {
    pub use super::backend::url_provider::*;
}
