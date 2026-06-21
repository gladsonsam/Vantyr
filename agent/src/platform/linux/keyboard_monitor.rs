//! Linux keyboard / AFK monitor via raw `/dev/input/event*` (evdev).
//!
//! Wayland deliberately blocks global keystroke capture through portals, so on
//! Wayland the only way to observe keys is the kernel evdev interface. We read
//! the raw `input_event` records directly (no crate — the struct is a stable
//! kernel ABI), which works identically on Wayland and X11.
//!
//! **Permissions:** `/dev/input/event*` is readable by root or members of the
//! `input` group. Without access the monitor degrades to a no-op and the
//! capability block reports `keyboard_monitor: "needs_privilege"`. Add the agent
//! user to `input` (or run elevated) to enable it.
//!
//! **Caveats / first-version scope:** reading evdev gives global keystrokes with
//! no compositor-provided window attribution, so we attribute each flushed burst
//! to the active window sampled at flush time (Hyprland only for now). The keymap
//! is a fixed US QWERTY layout with shift/caps-lock; non-US layouts and dead keys
//! are not yet translated. `input_event` is assumed 64-bit (24-byte records),
//! which covers x86_64/aarch64.

use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc::Sender;
use tracing::{info, warn};

pub use crate::platform::types::InputEvent;

/// `EV_KEY` event type from `linux/input-event-codes.h`.
const EV_KEY: u16 = 1;
/// Size of `struct input_event` on 64-bit Linux (timeval(16) + type(2) + code(2) + value(4)).
const EVENT_SIZE: usize = 24;

const AFK_THRESHOLD_SECS: u64 = 60;
const FLUSH_CHARS: usize = 200;
const FLUSH_SILENCE_MS: u64 = 3_000;

// Modifier / special keycodes.
const KEY_BACKSPACE: u16 = 14;
const KEY_TAB: u16 = 15;
const KEY_ENTER: u16 = 28;
const KEY_LEFTSHIFT: u16 = 42;
const KEY_RIGHTSHIFT: u16 = 54;
const KEY_CAPSLOCK: u16 = 58;
const KEY_SPACE: u16 = 57;

#[derive(Default)]
struct Shared {
    buffer: Mutex<String>,
    shift: AtomicBool,
    caps: AtomicBool,
    last_activity_ms: AtomicU64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

enum KeyAction {
    Text(char),
    Backspace,
    Newline,
    Ignore,
}

/// US QWERTY keycode → character, applying shift / caps-lock.
fn decode(code: u16, shift: bool, caps: bool) -> KeyAction {
    let letter = |lo: char, up: char| {
        if shift ^ caps {
            KeyAction::Text(up)
        } else {
            KeyAction::Text(lo)
        }
    };
    let sym = |lo: char, hi: char| {
        if shift {
            KeyAction::Text(hi)
        } else {
            KeyAction::Text(lo)
        }
    };
    match code {
        2 => sym('1', '!'),
        3 => sym('2', '@'),
        4 => sym('3', '#'),
        5 => sym('4', '$'),
        6 => sym('5', '%'),
        7 => sym('6', '^'),
        8 => sym('7', '&'),
        9 => sym('8', '*'),
        10 => sym('9', '('),
        11 => sym('0', ')'),
        12 => sym('-', '_'),
        13 => sym('=', '+'),
        KEY_BACKSPACE => KeyAction::Backspace,
        KEY_TAB => KeyAction::Text('\t'),
        16 => letter('q', 'Q'),
        17 => letter('w', 'W'),
        18 => letter('e', 'E'),
        19 => letter('r', 'R'),
        20 => letter('t', 'T'),
        21 => letter('y', 'Y'),
        22 => letter('u', 'U'),
        23 => letter('i', 'I'),
        24 => letter('o', 'O'),
        25 => letter('p', 'P'),
        26 => sym('[', '{'),
        27 => sym(']', '}'),
        KEY_ENTER => KeyAction::Newline,
        30 => letter('a', 'A'),
        31 => letter('s', 'S'),
        32 => letter('d', 'D'),
        33 => letter('f', 'F'),
        34 => letter('g', 'G'),
        35 => letter('h', 'H'),
        36 => letter('j', 'J'),
        37 => letter('k', 'K'),
        38 => letter('l', 'L'),
        39 => sym(';', ':'),
        40 => sym('\'', '"'),
        41 => sym('`', '~'),
        43 => sym('\\', '|'),
        44 => letter('z', 'Z'),
        45 => letter('x', 'X'),
        46 => letter('c', 'C'),
        47 => letter('v', 'V'),
        48 => letter('b', 'B'),
        49 => letter('n', 'N'),
        50 => letter('m', 'M'),
        51 => sym(',', '<'),
        52 => sym('.', '>'),
        53 => sym('/', '?'),
        KEY_SPACE => KeyAction::Text(' '),
        _ => KeyAction::Ignore,
    }
}

/// Whether at least one `/dev/input/event*` device can be opened for reading.
/// Used to report the keyboard capability honestly.
pub fn can_read_input_devices() -> bool {
    let Ok(entries) = std::fs::read_dir("/dev/input") else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("event") && std::fs::File::open(entry.path()).is_ok() {
            return true;
        }
    }
    false
}

fn spawn_reader(mut file: std::fs::File, shared: Arc<Shared>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; EVENT_SIZE];
        loop {
            if file.read_exact(&mut buf).is_err() {
                break; // device removed or read error
            }
            let etype = u16::from_ne_bytes([buf[16], buf[17]]);
            let code = u16::from_ne_bytes([buf[18], buf[19]]);
            let value = i32::from_ne_bytes([buf[20], buf[21], buf[22], buf[23]]);
            if etype != EV_KEY {
                continue;
            }
            match code {
                KEY_LEFTSHIFT | KEY_RIGHTSHIFT => {
                    shared.shift.store(value != 0, Ordering::Relaxed);
                }
                KEY_CAPSLOCK => {
                    if value == 1 {
                        shared.caps.fetch_xor(true, Ordering::Relaxed);
                    }
                }
                _ => {
                    // value: 0=release, 1=press, 2=autorepeat.
                    if value == 1 || value == 2 {
                        shared.last_activity_ms.store(now_ms(), Ordering::Relaxed);
                        let action = decode(
                            code,
                            shared.shift.load(Ordering::Relaxed),
                            shared.caps.load(Ordering::Relaxed),
                        );
                        let mut b = shared.buffer.lock().unwrap_or_else(|e| e.into_inner());
                        match action {
                            KeyAction::Text(c) => b.push(c),
                            KeyAction::Newline => b.push('\n'),
                            KeyAction::Backspace => {
                                b.pop();
                            }
                            KeyAction::Ignore => {}
                        }
                    }
                }
            }
        }
    });
}

fn flush_buffer(shared: &Shared, tx: &Sender<InputEvent>) {
    let text = {
        let mut b = shared.buffer.lock().unwrap_or_else(|e| e.into_inner());
        if b.is_empty() {
            return;
        }
        std::mem::take(&mut *b)
    };
    let win = super::activity_tracker::current_window();
    let (app, app_display, window) = win
        .map(|w| (w.app, w.app_display, w.title))
        .unwrap_or_default();
    let _ = tx.try_send(InputEvent::Keys {
        text,
        app,
        app_display,
        window,
        ts: crate::unix_timestamp_secs(),
    });
}

pub fn start(out_tx: Sender<InputEvent>) -> anyhow::Result<()> {
    let shared = Arc::new(Shared::default());
    shared.last_activity_ms.store(now_ms(), Ordering::Relaxed);

    // Open every readable evdev device and read it on its own thread. Non-keyboard
    // devices only emit keycodes we don't map (mouse BTN_*, etc.), so they're
    // harmless to read.
    let mut opened = 0usize;
    if let Ok(entries) = std::fs::read_dir("/dev/input") {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if !name.to_string_lossy().starts_with("event") {
                continue;
            }
            match std::fs::File::open(entry.path()) {
                Ok(file) => {
                    spawn_reader(file, shared.clone());
                    opened += 1;
                }
                Err(e) => {
                    tracing::debug!("keyboard_monitor: cannot open {:?}: {e}", entry.path());
                }
            }
        }
    }

    if opened == 0 {
        warn!(
            "Keyboard capture unavailable: no readable /dev/input/event* devices. \
             Add the agent user to the 'input' group or run elevated."
        );
        return Ok(());
    }
    info!("Keyboard capture started (evdev): reading {opened} input device(s).");

    // Flusher: emit buffered keystrokes on size/silence thresholds.
    let flush_shared = shared.clone();
    let flush_tx = out_tx.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let now = now_ms();
        let last = flush_shared.last_activity_ms.load(Ordering::Relaxed);
        let len = flush_shared
            .buffer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len();
        if len > 0 && (len >= FLUSH_CHARS || now.saturating_sub(last) >= FLUSH_SILENCE_MS) {
            flush_buffer(&flush_shared, &flush_tx);
        }
    });

    // AFK watcher: emit Afk / Active transitions.
    let afk_shared = shared;
    let afk_tx = out_tx;
    std::thread::spawn(move || {
        let mut is_afk = false;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let idle_secs =
                now_ms().saturating_sub(afk_shared.last_activity_ms.load(Ordering::Relaxed)) / 1000;
            if !is_afk && idle_secs >= AFK_THRESHOLD_SECS {
                is_afk = true;
                flush_buffer(&afk_shared, &afk_tx); // flush before going idle
                let _ = afk_tx.try_send(InputEvent::Afk { idle_secs });
            } else if is_afk && idle_secs < AFK_THRESHOLD_SECS {
                is_afk = false;
                let _ = afk_tx.try_send(InputEvent::Active);
            }
        }
    });

    Ok(())
}
