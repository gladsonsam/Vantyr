//! Remote input (mouse, keyboard, `Notify`): the raw JSON goes to the session's
//! [`InputController`], which maps capture geometry and parses its own
//! `ControlCommand`.

use tracing::warn;

use crate::input::remote::InputController;

pub(super) fn handle(text: &str, controller: Option<&mut InputController>) {
    match controller {
        Some(ctrl) if crate::permissions::allowed(crate::permissions::Module::RemoteInput) => {
            if let Err(e) = ctrl.handle_command(text) {
                warn!("Control command error: {e:#}");
            }
        }
        _ => {
            warn!("Ignoring remote input command: input injection unavailable on this session.");
        }
    }
}
