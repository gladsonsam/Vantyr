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
use std::cell::RefCell;
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
    CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetWindowTextW,
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

// `InputEvent` is defined once in the platform seam (`platform::types`) so the
// Windows and Linux keyboard backends share one shape. Re-exported for the
// existing call sites in this module.
pub use crate::platform::types::InputEvent;

// ─── Global hook channel ──────────────────────────────────────────────────────

/// Sends decoded keystrokes from the hook callback to the decoder thread.
/// Thread-local so each hook generation can replace and tear down its sender.
thread_local! {
    static HOOK_TX: RefCell<Option<std::sync::mpsc::SyncSender<String>>> = const { RefCell::new(None) };
    /// Same thread as [`SetWindowsHookExW`] / hook callback; [`HHOOK`] is not `Sync` for a `static`.
    static HOOK_TLS: Cell<Option<HHOOK>> = const { Cell::new(None) };
}

// ─── Hook callback ────────────────────────────────────────────────────────────

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && crate::permissions::allowed(crate::permissions::Module::KeyboardText) {
        let msg = wparam.0 as u32;
        if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
            let kbd = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            let decoded = decode_key(kbd.vkCode, kbd.scanCode);
            if !decoded.is_empty() {
                HOOK_TX.with(|cell| {
                    if let Some(tx) = cell.borrow().as_ref() {
                        // try_send: drop the event rather than block the hook (never stall input).
                        let _ = tx.try_send(decoded);
                    }
                });
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
/// `out_tx`. Hook generations stop and restart with local authorization.
pub fn start(out_tx: Sender<InputEvent>) -> anyhow::Result<()> {
    tokio::spawn(run_afk_watcher(out_tx.clone()));
    std::thread::Builder::new()
        .name("keyboard-supervisor".into())
        .spawn(move || loop {
            while !crate::permissions::allowed(crate::permissions::Module::KeyboardText) {
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            let (raw_tx, raw_rx) = std::sync::mpsc::sync_channel::<String>(512);
            let tx = out_tx.clone();
            let decoder = std::thread::spawn(move || run_decoder(raw_rx, tx));
            unsafe {
                HOOK_TX.with(|c| *c.borrow_mut() = Some(raw_tx));
                if let Ok(hook) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0) {
                    HOOK_TLS.with(|c| c.set(Some(hook)));
                    let mut msg = MSG::default();
                    while crate::permissions::allowed(crate::permissions::Module::KeyboardText) {
                        while windows::Win32::UI::WindowsAndMessaging::PeekMessageW(
                            &raw mut msg,
                            None,
                            0,
                            0,
                            windows::Win32::UI::WindowsAndMessaging::PM_REMOVE,
                        )
                        .as_bool()
                        {
                            let _ = TranslateMessage(&raw const msg);
                            DispatchMessageW(&raw const msg);
                        }
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                    let _ = UnhookWindowsHookEx(hook);
                    HOOK_TLS.with(|c| c.set(None));
                }
                HOOK_TX.with(|c| *c.borrow_mut() = None);
            }
            let _ = decoder.join();
            std::thread::sleep(std::time::Duration::from_secs(1));
        })?;
    Ok(())
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
                if !crate::permissions::allowed(crate::permissions::Module::KeyboardText) {
                    buf.clear();
                    continue;
                }
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
    if !crate::permissions::allowed(crate::permissions::Module::KeyboardText) {
        return;
    }
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
        if !crate::permissions::allowed(crate::permissions::Module::IdleActivity) {
            was_afk = false;
            last_input_mono = Instant::now();
            continue;
        }

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
    if !crate::permissions::allowed(crate::permissions::Module::WindowActivity) {
        return Default::default();
    }
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
