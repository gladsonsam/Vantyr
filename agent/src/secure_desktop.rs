//! Secure-desktop attachment helpers (Windows).
//!
//! Windows has multiple *desktops* inside the interactive window station
//! `WinSta0`: the normal `Default` desktop, and the secure `Winlogon` desktop
//! used by the sign-in / lock / UAC screens. A thread can only capture pixels
//! from — or inject input into — the desktop it is **attached** to
//! (`SetThreadDesktop`), and a given desktop's DACL only grants access to
//! SYSTEM plus, for `Default`, the signed-in user. That is why the ordinary
//! user-session agent can never see the lock screen: it is pinned to `Default`
//! and its token has no rights on `Winlogon`.
//!
//! These helpers let the SYSTEM capture worker attach the *calling thread* to
//! whichever desktop currently receives input, and notice when that changes
//! (sign-in → lock → UAC prompt → unlock). The worker re-runs
//! [`attach_current_thread_to_input_desktop`] and rebuilds its capture/input
//! state whenever [`input_desktop_name`] changes.

use anyhow::{bail, Context, Result};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, SetThreadDesktop,
    DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS, HDESK, UOI_NAME,
};

/// All object-specific desktop rights (`DESKTOP_*`) OR'd together
/// (`DESKTOP_ALL_ACCESS` minus the standard-rights bits). Enough to read pixels
/// from and inject input into the desktop after `SetThreadDesktop`.
const DESKTOP_OBJECT_RIGHTS: u32 = 0x0000_01FF;

/// RAII wrapper around a desktop handle attached to the current thread.
///
/// Dropping it closes the handle. Keep it alive for as long as the thread stays
/// attached (i.e. for the lifetime of one capture/input generation); attaching a
/// new desktop and dropping the old wrapper is the normal switch path.
pub struct DesktopAttachment {
    hdesk: HDESK,
    name: String,
}

impl DesktopAttachment {
    /// Name of the desktop this thread is attached to (e.g. `Default`, `Winlogon`).
    pub fn name(&self) -> &str {
        &self.name
    }
}

impl Drop for DesktopAttachment {
    fn drop(&mut self) {
        // Best-effort: the thread should have moved off this desktop (or be exiting)
        // before we close the handle.
        let _ = unsafe { CloseDesktop(self.hdesk) };
    }
}

/// Open the desktop currently receiving user input and attach the **calling
/// thread** to it. Must be called before the thread creates any windows/hooks —
/// `SetThreadDesktop` fails once the thread owns UI objects, so callers run
/// capture/input on a freshly spawned thread and re-attach by respawning.
///
/// Returns an error when there is no reachable input desktop (rare, transient
/// during session transitions) so the caller can back off and retry.
pub fn attach_current_thread_to_input_desktop() -> Result<DesktopAttachment> {
    // DF_ALLOWOTHERACCOUNTHOOK = 1; 0 is fine — we are SYSTEM and own the desktop.
    let hdesk = unsafe {
        OpenInputDesktop(
            DESKTOP_CONTROL_FLAGS(0),
            false,
            DESKTOP_ACCESS_FLAGS(DESKTOP_OBJECT_RIGHTS),
        )
    }
    .context("OpenInputDesktop (no reachable input desktop)")?;

    if let Err(e) = unsafe { SetThreadDesktop(hdesk) } {
        let _ = unsafe { CloseDesktop(hdesk) };
        bail!("SetThreadDesktop failed: {e}");
    }

    let name = desktop_name(hdesk).unwrap_or_default();
    Ok(DesktopAttachment { hdesk, name })
}

/// Name of the desktop that currently owns input, without attaching to it.
///
/// Used as a cheap change-detector: capture/input threads poll this and, when it
/// differs from the desktop they attached to, exit so a supervisor re-attaches to
/// the new one. Returns `None` transiently when no input desktop is reachable.
pub fn input_desktop_name() -> Option<String> {
    let hdesk = unsafe {
        OpenInputDesktop(
            DESKTOP_CONTROL_FLAGS(0),
            false,
            DESKTOP_ACCESS_FLAGS(DESKTOP_OBJECT_RIGHTS),
        )
    }
    .ok()?;
    let name = desktop_name(hdesk).ok();
    let _ = unsafe { CloseDesktop(hdesk) };
    name
}

fn desktop_name(hdesk: HDESK) -> Result<String> {
    // First call: ask for the required byte length.
    let mut needed: u32 = 0;
    let handle = HANDLE(hdesk.0);
    // A zero-length probe returns ERROR_INSUFFICIENT_BUFFER and fills `needed`.
    let _ = unsafe { GetUserObjectInformationW(handle, UOI_NAME, None, 0, Some(&raw mut needed)) };
    if needed == 0 {
        // Fall back to a reasonable fixed buffer if the probe gave nothing.
        needed = 256;
    }

    let mut buf = vec![0u8; needed as usize];
    unsafe {
        GetUserObjectInformationW(
            handle,
            UOI_NAME,
            Some(buf.as_mut_ptr().cast()),
            needed,
            Some(&raw mut needed),
        )
    }
    .context("GetUserObjectInformationW(UOI_NAME)")?;

    // The buffer holds a wide, NUL-terminated string.
    let wide: &[u16] =
        unsafe { std::slice::from_raw_parts(buf.as_ptr().cast::<u16>(), (needed as usize) / 2) };
    let end = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
    Ok(String::from_utf16_lossy(&wide[..end]))
}
