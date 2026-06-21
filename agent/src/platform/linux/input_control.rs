//! Linux remote input injection.
//!
//! Delegates to the shared `enigo` controller, which works on X11 (XTest).
//! Wayland input needs the RemoteDesktop portal + libei or `/dev/uinput` (via an
//! elevated path) and is a later increment.

pub use crate::input::InputController;
