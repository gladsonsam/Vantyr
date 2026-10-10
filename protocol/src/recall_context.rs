//! The foreground context an agent attaches to a Recall keyframe.
//!
//! The agent builds a [`Context`] around each capture; the server re-validates
//! it field by field before it reaches the database or the API, so a buggy or
//! hostile agent cannot smuggle values past the grants. Both sides share the
//! vocabulary (statuses, reasons, sources) and the limits defined here.
//!
//! The server validates raw JSON component by component rather than parsing a
//! [`Context`], so one bad component does not discard the good ones. Agents
//! therefore must not rely on the server accepting more than these types hold.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::modules::Module;

/// The only context schema version.
pub const CONTEXT_VERSION: u8 = 1;
/// The only context scope: the foreground window of the capturing session.
pub const CONTEXT_SCOPE: &str = "session_foreground";
/// Longest bracket (time between the two foreground samples) a context may claim.
pub const MAX_BRACKET_MS: u32 = 1000;
/// Largest serialized context the server will look at.
pub const MAX_CONTEXT_BYTES: usize = 4096;
/// Byte caps on the window values.
pub const MAX_APP_BYTES: usize = 256;
pub const MAX_TITLE_BYTES: usize = 1024;
/// Values `monitor_relation` may take on the wire.
pub const MONITOR_RELATIONS: &[&str] = &["unknown", "same", "other"];

macro_rules! wire_enum {
    ($(#[$meta:meta])* $name:ident as $ts_name:literal { $($(#[$vmeta:meta])* $variant:ident => $wire:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, rename = $ts_name))]
        #[serde(rename_all = "snake_case")]
        pub enum $name {
            $($(#[$vmeta])* $variant),+
        }

        impl $name {
            /// The snake_case wire string.
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire),+
                }
            }

            /// The value for a wire string; `None` for anything unrecognised.
            pub fn from_wire(wire: &str) -> Option<Self> {
                match wire {
                    $($wire => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

wire_enum! {
    /// How trustworthy a component is.
    Status as "RecallContextStatus" {
        Observed => "observed",
        Uncertain => "uncertain",
        Unknown => "unknown",
        NotCollected => "not_collected",
    }
}

wire_enum! {
    /// Why a component has no value.
    Reason as "RecallContextReason" {
        ModuleDisabled => "module_disabled",
        Revoked => "revoked",
        Unsupported => "unsupported",
        NoForeground => "no_foreground",
        ReadFailed => "read_failed",
        SampleTimeout => "sample_timeout",
        Changed => "changed",
        IdentityUnverified => "identity_unverified",
        /// Not emitted by agents today; the server accepts it for browser components.
        NotBrowser => "not_browser",
        /// Server-assigned: a browser host failed validation.
        InvalidUrl => "invalid_url",
        /// Server-assigned: a component failed validation.
        InvalidContext => "invalid_context",
    }
}

wire_enum! {
    /// Where a component's value was read from.
    Source as "RecallContextSource" {
        Win32 => "win32",
        Hyprland => "hyprland",
        /// Browser address-bar provider; not emitted by agents today.
        UiaHwnd => "uia_hwnd",
        None => "none",
    }
}

impl Source {
    /// Whether a window component may report this source.
    pub fn is_window_source(self) -> bool {
        matches!(self, Self::Win32 | Self::Hyprland | Self::None)
    }

    /// Whether a browser component may report this source.
    pub fn is_browser_source(self) -> bool {
        matches!(self, Self::UiaHwnd | Self::None)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowContext {
    pub status: Status,
    pub reason: Option<Reason>,
    pub source: Source,
    pub app: Option<String>,
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub title_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserContext {
    pub status: Status,
    pub reason: Option<Reason>,
    pub source: Source,
    // This slice never reads URL providers or emits URL/host values.
    pub url: Option<String>,
    pub url_host: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Context {
    pub version: u8,
    pub scope: String,
    pub bracket_ms: u32,
    pub monitor_relation: String,
    pub window: WindowContext,
    pub browser: BrowserContext,
    pub grant_revisions: BTreeMap<Module, u64>,
}

impl WindowContext {
    /// A window component with no value.
    pub fn empty(status: Status, reason: Reason) -> Self {
        Self {
            status,
            reason: Some(reason),
            source: Source::None,
            app: None,
            title: None,
            title_truncated: false,
        }
    }
}

impl Context {
    /// Whether the envelope is one this protocol version understands.
    pub fn is_supported(&self) -> bool {
        self.version == CONTEXT_VERSION
            && self.scope == CONTEXT_SCOPE
            && self.bracket_ms <= MAX_BRACKET_MS
    }

    /// Only successful value changes affect image dedup; error/reason oscillation does not.
    pub fn signature(&self) -> Option<(Option<String>, Option<String>)> {
        (self.window.status == Status::Observed)
            .then(|| (self.window.app.clone(), self.window.title.clone()))
    }
}

/// Strip control characters and cut `raw` to at most `max` bytes on a character
/// boundary. The flag is true when the text was cut.
pub fn bounded_clean(raw: &str, max: usize) -> (String, bool) {
    let clean: String = raw.chars().filter(|c| !c.is_control()).collect();
    if clean.len() <= max {
        return (clean, false);
    }
    let mut end = max;
    while !clean.is_char_boundary(end) {
        end -= 1;
    }
    (clean[..end].into(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_strings_round_trip_and_match_serde() {
        for status in [
            Status::Observed,
            Status::Uncertain,
            Status::Unknown,
            Status::NotCollected,
        ] {
            assert_eq!(Status::from_wire(status.as_str()), Some(status));
            assert_eq!(
                serde_json::to_value(status).unwrap(),
                serde_json::json!(status.as_str())
            );
        }
        for reason in [
            Reason::ModuleDisabled,
            Reason::Revoked,
            Reason::Unsupported,
            Reason::NoForeground,
            Reason::ReadFailed,
            Reason::SampleTimeout,
            Reason::Changed,
            Reason::IdentityUnverified,
            Reason::NotBrowser,
            Reason::InvalidUrl,
            Reason::InvalidContext,
        ] {
            assert_eq!(Reason::from_wire(reason.as_str()), Some(reason));
            assert_eq!(
                serde_json::to_value(reason).unwrap(),
                serde_json::json!(reason.as_str())
            );
        }
        for source in [
            Source::Win32,
            Source::Hyprland,
            Source::UiaHwnd,
            Source::None,
        ] {
            assert_eq!(Source::from_wire(source.as_str()), Some(source));
            assert_eq!(
                serde_json::to_value(source).unwrap(),
                serde_json::json!(source.as_str())
            );
        }
        assert_eq!(Status::from_wire("Observed"), None);
        assert_eq!(Reason::from_wire(""), None);
        assert_eq!(Source::from_wire("uia"), None);
    }

    #[test]
    fn components_accept_their_own_sources_only() {
        assert!(Source::Win32.is_window_source() && !Source::Win32.is_browser_source());
        assert!(Source::UiaHwnd.is_browser_source() && !Source::UiaHwnd.is_window_source());
        assert!(Source::None.is_window_source() && Source::None.is_browser_source());
    }

    #[test]
    fn bounded_clean_strips_controls_and_cuts_on_a_char_boundary() {
        assert_eq!(bounded_clean("a\0b\n", 8), ("ab".to_owned(), false));
        let (cut, truncated) = bounded_clean(&"文".repeat(400), 1024);
        assert_eq!((cut.len(), truncated), (1023, true));
        assert_eq!(bounded_clean("abc", 3), ("abc".to_owned(), false));
    }

    #[test]
    fn envelope_support_checks_version_scope_and_bracket() {
        let mut context = Context {
            version: 1,
            scope: CONTEXT_SCOPE.into(),
            bracket_ms: 1000,
            monitor_relation: "unknown".into(),
            window: WindowContext::empty(Status::NotCollected, Reason::ModuleDisabled),
            browser: BrowserContext {
                status: Status::NotCollected,
                reason: Some(Reason::ModuleDisabled),
                source: Source::None,
                url: None,
                url_host: None,
            },
            grant_revisions: BTreeMap::new(),
        };
        assert!(context.is_supported());
        context.bracket_ms = 1001;
        assert!(!context.is_supported());
        context.bracket_ms = 0;
        context.version = 2;
        assert!(!context.is_supported());
        context.version = 1;
        context.scope = "other".into();
        assert!(!context.is_supported());
    }
}
