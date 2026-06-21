//! Shared, OS-neutral data types produced by every platform backend.
//!
//! Defining these once — instead of letting each backend declare its own
//! look-alike struct/enum — means the Windows and Linux backends physically
//! cannot diverge on field names or shapes. A rename here is a compile error in
//! every backend at once, which is the whole point of the platform seam.
//!
//! Backends turn their OS-native results into these types at their boundary
//! (e.g. Windows converts `browser_url::BrowserInfo` into [`ActiveUrl`]).

/// A foreground-window change emitted by the [`crate::platform::activity_tracker`] backend.
#[derive(Debug, Clone)]
pub struct WindowEvent {
    /// Full window title (e.g. `"Rust docs – Google Chrome"`).
    pub title: String,
    /// Short executable name (e.g. `"msedge.exe"`, `"chrome"`).
    pub app: String,
    /// Friendly executable name (e.g. `"Microsoft Edge"`); falls back to `app`.
    pub app_display: String,
    /// Full image path. Empty when unavailable.
    pub app_path: String,
    /// OS window handle (Windows `HWND`) or PID (Linux) for server-side correlation.
    pub hwnd: usize,
}

/// An event produced by the [`crate::platform::keyboard_monitor`] backend.
#[derive(Debug, Clone)]
pub enum InputEvent {
    /// A decoded burst of keystrokes associated with a specific window.
    Keys {
        /// Unicode text (printable chars + special-key labels like `[⌫]`).
        text: String,
        /// Executable basename, e.g. `"chrome.exe"`.
        app: String,
        /// Friendly executable name (e.g. `"Microsoft Edge"`).
        app_display: String,
        /// Window title at the time of typing.
        window: String,
        /// UNIX timestamp (seconds).
        ts: u64,
    },
    /// User has been idle for at least `idle_secs` seconds.
    Afk { idle_secs: u64 },
    /// User resumed input after an AFK period.
    Active,
}

/// The active browser tab, as reported by the [`crate::platform::url_provider`] backend.
///
/// Windows derives this from `browser_url`/UIAutomation; Linux will derive it
/// from a browser extension or accessibility bus. The shape is identical so the
/// agent loop consumes one type regardless of platform.
#[derive(Debug, Clone)]
pub struct ActiveUrl {
    pub url: String,
    pub title: String,
    pub browser_name: String,
}
