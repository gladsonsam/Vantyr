//! # Input Injection Module
//!
//! Deserialises JSON control commands that arrive as **text frames** on the
//! WebSocket and executes them via the [`enigo`] input-simulation library
//! (v0.2+).

use anyhow::{Context, Result};
use enigo::{Axis, Button, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde::Deserialize;
use tracing::{info, warn};

// Cursor placement and desktop notifications are the OS-specific parts.
#[cfg(not(windows))]
mod linux;
#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
use self::linux as imp;
#[cfg(windows)]
use self::windows as imp;

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

fn special_key_to_enigo(k: SpecialKey) -> Key {
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

// ─────────────────────────────────────────────────────────────────────────────
// Controller
// ─────────────────────────────────────────────────────────────────────────────

/// Owns an [`Enigo`] context and dispatches inbound [`ControlCommand`]s.
///
/// Construct once per session and reuse — creating multiple `Enigo` instances
/// simultaneously can conflict on some Windows input driver backends.
pub struct InputController {
    enigo: Enigo,
    held_keys: Vec<Key>,
    held_buttons: Vec<Button>,
    generation: Option<crate::permissions::Generation>,
    lease: Option<crate::permissions::WorkerLease>,
}

const MAX_TYPE_TEXT_CHARS: usize = 2_000;
/// Clamp scroll delta to prevent runaway scrolling from a malformed payload.
const MAX_SCROLL_NOTCHES: i32 = 20;

fn release_held<T: Copy, E>(held: &mut Vec<T>, mut release: impl FnMut(T) -> Result<(), E>) {
    held.retain(|item| release(*item).is_err());
}
impl InputController {
    /// Initialise the Enigo input backend.
    pub fn new() -> Result<Self> {
        let enigo = Enigo::new(&Settings::default())
            .context("Failed to initialise Enigo input controller")?;
        Ok(Self {
            enigo,
            held_keys: Vec::new(),
            held_buttons: Vec::new(),
            generation: None,
            lease: None,
        })
    }

    /// Lifecycle cleanup must bypass authorization: revoked input still needs
    /// release events. Keep failed releases tracked for a later retry.
    pub fn release_all(&mut self) {
        release_held(&mut self.held_keys, |key| {
            self.enigo.key(key, Direction::Release)
        });
        release_held(&mut self.held_buttons, |button| {
            self.enigo.button(button, Direction::Release)
        });
        self.generation = None;
        if self.held_keys.is_empty() && self.held_buttons.is_empty() {
            self.lease = None;
        }
    }
    pub fn cleanup_revoked(&mut self) {
        if self.generation.is_some_and(|g| !g.valid())
            || self.generation.is_none()
                && (!self.held_keys.is_empty() || !self.held_buttons.is_empty())
        {
            self.release_all();
        }
    }

    fn move_absolute(&mut self, x: i32, y: i32) -> Result<()> {
        imp::move_absolute(&mut self.enigo, x, y)
    }
    /// Parse control JSON, validate permissions/geometry, then inject input.
    pub fn handle_command(&mut self, json: &str) -> Result<()> {
        anyhow::ensure!(
            crate::permissions::allowed(crate::permissions::Module::RemoteInput),
            "remote input not locally authorized"
        );
        self.cleanup_revoked();
        let mut val: serde_json::Value = serde_json::from_str(json)?;
        let generation = if val["__module_generation"].is_null() {
            crate::permissions::Generation::capture(crate::permissions::Module::RemoteInput)
        } else {
            serde_json::from_value(val["__module_generation"].clone()).ok()
        };
        anyhow::ensure!(
            generation
                .is_some_and(|g| g.module == crate::permissions::Module::RemoteInput && g.valid()),
            "stale input generation"
        );
        if self.generation != generation {
            self.release_all();
            anyhow::ensure!(
                self.held_keys.is_empty() && self.held_buttons.is_empty(),
                "previous input releases pending"
            );
            self.generation = generation;
            self.lease = generation.map(crate::permissions::WorkerLease::new);
        }
        // Keep selection locked through OS injection, so a switch cannot publish
        // between coordinate validation and the resulting click/drag.
        let geometry = crate::capture::geometry::selection();
        if let Err(e) = geometry.map_command(&mut val) {
            self.release_all();
            return Err(e);
        }
        let cmd: ControlCommand =
            serde_json::from_value(val).context("Invalid control command JSON")?;

        match cmd {
            // ── Mouse movement ────────────────────────────────────────────────
            ControlCommand::MouseMove { x, y } => {
                self.move_absolute(x, y).context("move_mouse failed")?;
            }

            // ── Atomic click ──────────────────────────────────────────────────
            ControlCommand::MouseClick { x, y, button } => {
                info!("→ MouseClick  x={x}  y={y}  button={button:?}");
                self.move_absolute(x, y)
                    .context("move_mouse (pre-click) failed")?;
                self.enigo
                    .button(button.into(), Direction::Click)
                    .context("button click failed")?;
            }

            ControlCommand::MouseDoubleClick { x, y, button } => {
                info!("→ MouseDoubleClick  x={x}  y={y}  button={button:?}");
                let btn: Button = button.into();
                self.move_absolute(x, y)
                    .context("move_mouse (pre-dblclick) failed")?;
                self.enigo
                    .button(btn, Direction::Click)
                    .context("double-click 1st failed")?;
                self.enigo
                    .button(btn, Direction::Click)
                    .context("double-click 2nd failed")?;
            }

            // ── Drag (split press / release) ──────────────────────────────────
            ControlCommand::MouseDown { x, y, button } => {
                info!("→ MouseDown  x={x}  y={y}  button={button:?}");
                self.move_absolute(x, y)
                    .context("move_mouse (pre-down) failed")?;
                self.enigo
                    .button(button.into(), Direction::Press)
                    .context("button press failed")?;
                let button: Button = button.into();
                if !self.held_buttons.contains(&button) {
                    self.held_buttons.push(button);
                }
            }

            ControlCommand::MouseUp { x, y, button } => {
                info!("→ MouseUp  x={x}  y={y}  button={button:?}");
                self.move_absolute(x, y)
                    .context("move_mouse (pre-up) failed")?;
                self.enigo
                    .button(button.into(), Direction::Release)
                    .context("button release failed")?;
                self.held_buttons.retain(|b| *b != button.into());
            }

            // ── Scroll ────────────────────────────────────────────────────────
            ControlCommand::MouseScroll { delta_x, delta_y } => {
                let dy = delta_y.clamp(-MAX_SCROLL_NOTCHES, MAX_SCROLL_NOTCHES);
                let dx = delta_x.clamp(-MAX_SCROLL_NOTCHES, MAX_SCROLL_NOTCHES);
                if dy != 0 {
                    self.enigo
                        .scroll(dy, Axis::Vertical)
                        .context("scroll vertical failed")?;
                }
                if dx != 0 {
                    self.enigo
                        .scroll(dx, Axis::Horizontal)
                        .context("scroll horizontal failed")?;
                }
            }

            // ── Text entry ────────────────────────────────────────────────────
            ControlCommand::TypeText { text } => {
                if text.is_empty() {
                    return Ok(());
                }
                let chars = text.chars().count();
                if chars > MAX_TYPE_TEXT_CHARS {
                    warn!("Ignoring TypeText: too long ({} chars)", chars);
                    return Ok(());
                }
                info!("→ TypeText  len={}", chars);
                self.enigo.text(&text).context("text injection failed")?;
            }

            // ── Special keys ──────────────────────────────────────────────────
            ControlCommand::KeyPress { key } => {
                info!("→ KeyPress  key={key:?}");
                self.enigo
                    .key(special_key_to_enigo(key), Direction::Click)
                    .context("key press failed")?;
            }

            ControlCommand::KeyDown { key } => {
                info!("→ KeyDown  key={key:?}");
                self.enigo
                    .key(special_key_to_enigo(key), Direction::Press)
                    .context("key down failed")?;
                let key = special_key_to_enigo(key);
                if !self.held_keys.contains(&key) {
                    self.held_keys.push(key);
                }
            }

            ControlCommand::KeyUp { key } => {
                info!("→ KeyUp  key={key:?}");
                self.enigo
                    .key(special_key_to_enigo(key), Direction::Release)
                    .context("key up failed")?;
                self.held_keys.retain(|k| *k != special_key_to_enigo(key));
            }

            // ── Character key press (respects held modifiers) ─────────────────
            ControlCommand::KeyChar { character } => {
                info!("→ KeyChar  char={character:?}");
                self.enigo
                    .key(Key::Unicode(character), Direction::Click)
                    .context("key char failed")?;
            }

            // ── Notifications ─────────────────────────────────────────────────
            ControlCommand::Notify { title, message } => imp::notify(&title, &message),
        }

        Ok(())
    }
}

impl Drop for InputController {
    fn drop(&mut self) {
        self.release_all();
    }
}

#[cfg(test)]
mod tests {
    use super::release_held;
    #[test]
    fn lifecycle_release_retries_failed_os_events() {
        let mut held = vec![1, 2];
        let mut releases = vec![];
        release_held(&mut held, |key| {
            releases.push(key);
            if key == 2 {
                Err(())
            } else {
                Ok(())
            }
        });
        assert_eq!(releases, vec![1, 2]);
        assert_eq!(held, vec![2]);
        release_held(&mut held, |_| Ok::<_, ()>(()));
        assert!(held.is_empty());
    }
}
