//! Platform facade for OS capabilities shared by several features, or that are
//! nothing but OS code (see `agent/docs/ARCHITECTURE.md`).
//!
//! Each capability below re-exports whichever backend (`windows` / `linux`) is
//! built for the current target; both backends keep their real code in
//! `platform/<os>/<capability>.rs`. Windows keeps the existing service/companion
//! implementation. Linux provides direct user-session backends where the
//! desktop, portal, or local privileges allow it, and reports unsupported
//! capabilities honestly when they do not.

#[cfg(not(windows))]
pub mod linux;
#[cfg(windows)]
pub mod windows;

#[cfg(not(windows))]
use self::linux as backend;
#[cfg(windows)]
use self::windows as backend;

/// OS-neutral data types every backend produces. Defined once so the Windows
/// and Linux backends cannot diverge on shape.
pub mod types;

/// Compiler-enforced contract: forces both backends to expose the same
/// capability entry points with identical signatures (see [`contract`]).
mod contract;

/// Foreground window changes and app icons.
pub mod activity_tracker {
    pub use super::backend::activity_tracker::*;
}

/// Keystroke and idle monitoring (keyboard text, AFK, screen-history activity).
pub mod keyboard_monitor {
    pub use super::backend::keyboard_monitor::*;
}

/// Kill-on-drop containment of a child process and its descendants.
pub mod process_tree {
    pub use super::backend::process_tree::*;
}

/// Lock, restart and shut down the host.
pub mod system_control {
    pub use super::backend::system_control::*;
}

/// Interactive remote terminal sessions.
pub mod terminal {
    pub use super::backend::terminal::*;
}

/// The active browser tab URL.
pub mod url_provider {
    pub use super::backend::url_provider::*;
}
