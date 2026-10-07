//! The inbound control commands: the strictly typed wire shape of remote input
//! ([`ControlCommand`]) and the mapping of its key names to `enigo` keys.

use enigo::{Button, Key};
use serde::Deserialize;

// ─────────────────────────────────────────────────────────────────────────────
// Wire types (deserialised from inbound JSON)
// ─────────────────────────────────────────────────────────────────────────────

/// Which mouse button to use for a click / down / up action.
#[derive(Debug, Deserialize, Default, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    #[default]
    Left,
    Right,
    Middle,
}

impl From<MouseButton> for Button {
    fn from(b: MouseButton) -> Self {
        match b {
            MouseButton::Left => Self::Left,
            MouseButton::Right => Self::Right,
            MouseButton::Middle => Self::Middle,
        }
    }
}

/// Every special / non-printable key the dashboard can send.
///
/// Serde uses `rename_all = "lowercase"` so the JSON wire value is just the
/// lowercased variant name (e.g. `"arrowup"`, `"pagedown"`, `"f5"`).
/// This matches what you get by calling `.toLowerCase()` on a browser
/// `KeyboardEvent.key` string.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SpecialKey {
    // ── Text editing ─────────────────────────────────────────────────────────
    Enter,
    Backspace,
    Tab,
    Escape,
    Delete,
    Insert,
    Space,
    // ── Navigation ───────────────────────────────────────────────────────────
    Home,
    End,
    PageUp,
    PageDown,
    // ── Arrow keys ───────────────────────────────────────────────────────────
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    // ── Function keys ────────────────────────────────────────────────────────
    F1,
    F2,
    F3,
    F4,
    F5,
    F6,
    F7,
    F8,
    F9,
    F10,
    F11,
    F12,
    // ── Modifier keys ────────────────────────────────────────────────────────
    /// Primary Control key (maps to LControl on Windows).
    Control,
    /// Primary Alt / Option key.
    Alt,
    /// Primary Shift key.
    Shift,
    /// Windows / Command (Meta) key.
    Meta,
    // ── Toggle keys ──────────────────────────────────────────────────────────
    CapsLock,
}

pub(super) fn special_key_to_enigo(k: SpecialKey) -> Key {
    match k {
        SpecialKey::Enter => Key::Return,
        SpecialKey::Backspace => Key::Backspace,
        SpecialKey::Tab => Key::Tab,
        SpecialKey::Escape => Key::Escape,
        SpecialKey::Delete => Key::Delete,
        SpecialKey::Insert => Key::Insert,
        SpecialKey::Space => Key::Space,
        SpecialKey::Home => Key::Home,
        SpecialKey::End => Key::End,
        SpecialKey::PageUp => Key::PageUp,
        SpecialKey::PageDown => Key::PageDown,
        SpecialKey::ArrowUp => Key::UpArrow,
        SpecialKey::ArrowDown => Key::DownArrow,
        SpecialKey::ArrowLeft => Key::LeftArrow,
        SpecialKey::ArrowRight => Key::RightArrow,
        SpecialKey::F1 => Key::F1,
        SpecialKey::F2 => Key::F2,
        SpecialKey::F3 => Key::F3,
        SpecialKey::F4 => Key::F4,
        SpecialKey::F5 => Key::F5,
        SpecialKey::F6 => Key::F6,
        SpecialKey::F7 => Key::F7,
        SpecialKey::F8 => Key::F8,
        SpecialKey::F9 => Key::F9,
        SpecialKey::F10 => Key::F10,
        SpecialKey::F11 => Key::F11,
        SpecialKey::F12 => Key::F12,
        // Use generic (non-sided) modifier keys — they work on all platforms.
        SpecialKey::Control => Key::Control,
        SpecialKey::Alt => Key::Alt,
        SpecialKey::Shift => Key::Shift,
        SpecialKey::Meta => Key::Meta,
        SpecialKey::CapsLock => Key::CapsLock,
    }
}

/// A control command received from the server over the WebSocket.
///
/// Serde's **internally tagged** representation uses the `"type"` field to
/// select the correct variant automatically.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ControlCommand {
    // ── Mouse movement ───────────────────────────────────────────────────────
    /// Move the OS cursor to an absolute screen coordinate.
    MouseMove { x: i32, y: i32 },

    // ── Mouse clicks (atomic press+release) ──────────────────────────────────
    /// Move to a coordinate then perform a full press+release click.
    MouseClick {
        x: i32,
        y: i32,
        #[serde(default)]
        button: MouseButton,
    },

    /// Move to a coordinate then perform two rapid press+release clicks.
    MouseDoubleClick {
        x: i32,
        y: i32,
        #[serde(default)]
        button: MouseButton,
    },

    // ── Mouse button down / up (for drag operations) ──────────────────────────
    /// Move to a coordinate and **press** (hold) a mouse button.
    /// Must be paired with a `MouseUp` to avoid a stuck button.
    MouseDown {
        x: i32,
        y: i32,
        #[serde(default)]
        button: MouseButton,
    },

    /// Move to a coordinate and **release** a previously pressed mouse button.
    MouseUp {
        x: i32,
        y: i32,
        #[serde(default)]
        button: MouseButton,
    },

    // ── Scroll wheel ─────────────────────────────────────────────────────────
    /// Scroll at the current cursor position.
    ///
    /// `delta_x` / `delta_y` are in scroll-wheel **notches** (integers).
    /// Positive `delta_y` = scroll down (content moves up).
    /// Positive `delta_x` = scroll right.
    MouseScroll { delta_x: i32, delta_y: i32 },

    // ── Keyboard – text entry ────────────────────────────────────────────────
    /// Type literal Unicode text into the focused window.
    TypeText { text: String },

    // ── Keyboard – special keys ───────────────────────────────────────────────
    /// Press **and release** a special key in a single atomic operation.
    KeyPress { key: SpecialKey },

    /// **Press** (hold) a special key — use `KeyUp` to release.
    /// Primarily used to engage modifier keys before sending a `KeyChar`.
    KeyDown { key: SpecialKey },

    /// **Release** a previously held special key.
    KeyUp { key: SpecialKey },

    /// Press and release a **single Unicode character** as a physical key event.
    ///
    /// Use this when modifier keys are already held via `KeyDown` so the OS
    /// sees the correct modifier+key combination (e.g. Ctrl+C, Alt+F4).
    /// Unlike `TypeText`, this goes through the key-event path which respects
    /// active modifier state.
    KeyChar {
        #[serde(rename = "char")]
        character: char,
    },

    // ── System ────────────────────────────────────────────────────────────────
    /// Display a Windows toast notification on the agent machine.
    Notify { title: String, message: String },
}
