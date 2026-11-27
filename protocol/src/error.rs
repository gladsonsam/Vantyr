//! Errors from the single strict wire contract.
//!
//! An error carries only a stable code and, where useful, the name of the field
//! that failed. It never carries the offending frame, command payload or any
//! secret: boundary logging prints the code, not attacker-controlled bytes.

use std::fmt;

/// Why a wire frame was rejected. Every variant fails closed at the receiver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    /// The frame is not a JSON object with a string `"type"`.
    MalformedFrame,
    /// The `"type"` is not one of the current wire types.
    UnknownType,
    /// A required field is absent.
    MissingField(&'static str),
    /// A field is present but has the wrong JSON type or an invalid value.
    InvalidField(&'static str),
    /// A bounded collection or string exceeds its current limit.
    TooLarge(&'static str),
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MalformedFrame => write!(f, "malformed_frame"),
            Self::UnknownType => write!(f, "unknown_type"),
            Self::MissingField(name) => write!(f, "missing_field:{name}"),
            Self::InvalidField(name) => write!(f, "invalid_field:{name}"),
            Self::TooLarge(name) => write!(f, "too_large:{name}"),
        }
    }
}

impl std::error::Error for ProtocolError {}

/// Map a serde error to a code-only error. The serde message can quote the
/// offending value, so it is deliberately not included.
pub(crate) fn from_serde(_error: serde_json::Error) -> ProtocolError {
    ProtocolError::MalformedFrame
}

/// A required field that deserialized as `None` was absent or explicitly null.
pub(crate) fn required<T>(field: &'static str, value: Option<T>) -> Result<T, ProtocolError> {
    value.ok_or(ProtocolError::MissingField(field))
}

/// Normalize an optional user name: blank means absent. This is a wire-value
/// normalization, not a compatibility reader — the field itself is still
/// strictly typed (`Option<String>`).
pub fn trimmed_non_empty(user: Option<String>) -> Option<String> {
    user.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}
