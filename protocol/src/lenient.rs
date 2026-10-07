//! Field readers that never fail a command: a missing field or one of the
//! wrong JSON type reads as absent, exactly like `as_str()` / `as_u64()` /
//! `as_bool()` on the raw value.

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

/// A string, empty when missing or not a string.
pub(crate) fn string<'de, D>(d: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(opt(d)?.unwrap_or_default())
}

/// `Some` whenever the field is present (null included), wrapping the
/// lenient value; the field's `#[serde(default)]` covers absence.
pub(crate) fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    opt(d).map(Some)
}

/// The elements of an array, empty when missing or not an array.
pub(crate) fn array<'de, D>(d: D) -> Result<Vec<serde_json::Value>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(opt(d)?.unwrap_or_default())
}

/// A string that parses as a UUID (any form `Uuid::parse_str` accepts).
pub(crate) fn uuid<'de, D>(d: D) -> Result<Option<uuid::Uuid>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(opt::<D, String>(d)?.and_then(|s| uuid::Uuid::parse_str(&s).ok()))
}
