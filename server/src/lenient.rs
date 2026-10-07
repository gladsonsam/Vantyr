//! Lenient agent-JSON field readers for ingest structs.
//!
//! Mirrors `vantyr-protocol`'s private `lenient` module (which cannot be used
//! here: it is private to that crate and `protocol/` must stay untouched). A
//! missing or wrongly-typed field reads as absent, exactly like the
//! `val["x"].as_str()` / `as_i64()` / `as_f64()` reads these replace. Every
//! helper never fails, so a struct with `#[serde(default)]` on every field
//! always deserializes.

use serde::{de::DeserializeOwned, Deserialize, Deserializer};

/// `Some` only when the value has the expected JSON type.
pub(crate) fn opt<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let value = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value(value).ok())
}

/// A string, empty when missing or not a string (like `as_str().unwrap_or("")`).
pub(crate) fn string<'de, D>(d: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(opt(d)?.unwrap_or_default())
}

/// An `i64`, zero when missing or not an integer (like `as_i64().unwrap_or(0)`).
pub(crate) fn i64_or_zero<'de, D>(d: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(opt::<D, i64>(d)?.unwrap_or(0))
}

/// A `user` field: trimmed, with empty or whitespace-only treated as absent
/// (like `as_str().map(trim).filter(!empty)`).
pub(crate) fn trimmed_non_empty(user: Option<String>) -> Option<String> {
    user.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}
