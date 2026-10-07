//! Windows screen capture: `xcap` plus input-desktop following for the SYSTEM
//! capture worker, so the lock/sign-in screen is captured too.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use tokio::sync::mpsc;
use tracing::{info, warn};

use super::CaptureSettings;

/// Enumerate the connected monitors for the dashboard's monitor picker.
pub fn list_monitors() -> Vec<serde_json::Value> {
    super::list_xcap_monitors()
}

/// Spawn the capture loop on a dedicated OS thread; the caller owns `stop`.
pub fn start_capture(
    tx: mpsc::Sender<Vec<u8>>,
    stop: Arc<AtomicBool>,
    settings: CaptureSettings,
    generation: crate::permissions::Generation,
) -> anyhow::Result<()> {
    super::start_xcap_capture(tx, stop, settings, generation)
}

/// SYSTEM capture worker: follow the input desktop. Attaching must happen
/// on a thread that has not yet created any windows (`SetThreadDesktop`
/// rejects a thread that owns UI objects), and xcap builds per-desktop
/// GPU/DXGI state — so each desktop generation runs a *fresh* capture pass
/// that exits when the input desktop switches (lock/unlock/UAC), after
/// which we re-attach and start a new pass.
pub(super) fn follow_input_desktop(
    stop: &Arc<AtomicBool>,
    generation: crate::permissions::Generation,
    geometry: &crate::capture::geometry::CaptureSession,
    mut pass: impl FnMut(Option<&str>),
) {
    loop {
        if stop.load(Ordering::Relaxed) || !generation.valid() || !geometry.current() {
            info!("Screen capture stopped on demand.");
            break;
        }
        match crate::capture::secure_desktop::attach_current_thread_to_input_desktop() {
            Ok(attachment) => {
                info!("Capture attached to input desktop '{}'.", attachment.name());
                pass(Some(attachment.name()));
                // Drop the attachment (closes the desktop handle) before the
                // next OpenInputDesktop/SetThreadDesktop attaches the new one.
                drop(attachment);
                // Settle briefly so a pass that returns instantly (e.g. no
                // monitor mid-transition) can't busy-spin the re-attach loop.
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => {
                // No reachable input desktop right now (transient during
                // session transitions). Back off and retry.
                geometry.invalidate();
                warn!("Capture: cannot attach to input desktop yet: {e:#}");
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    }
}

/// Notices when the input desktop switches away from the one a capture pass
/// attached to. Polls the input-desktop name at most a few times a second, not
/// every frame.
pub(super) struct DesktopWatch<'a> {
    expected: Option<&'a str>,
    last_check: std::time::Instant,
}

impl<'a> DesktopWatch<'a> {
    pub(super) fn new(expected: Option<&'a str>) -> Self {
        Self {
            expected,
            last_check: std::time::Instant::now(),
        }
    }

    pub(super) fn changed(&mut self) -> bool {
        let Some(expected) = self.expected else {
            return false;
        };
        if self.last_check.elapsed() >= Duration::from_millis(400) {
            self.last_check = std::time::Instant::now();
            if let Some(current) = crate::capture::secure_desktop::input_desktop_name() {
                if current != expected {
                    info!(
                        "Input desktop changed '{expected}' → '{current}'; re-attaching capture."
                    );
                    return true;
                }
            }
        }
        false
    }
}

pub(super) fn monitor_rect(m: &xcap::Monitor) -> Option<crate::capture::geometry::DesktopRect> {
    // xcap's Windows API uses EnumDisplaySettingsW DEVMODE dmPosition/dmPels*.
    let r = crate::capture::geometry::DesktopRect {
        x: m.x().ok()?,
        y: m.y().ok()?,
        physical_width: m.width().ok()?,
        physical_height: m.height().ok()?,
    };
    r.valid().then_some(r)
}
