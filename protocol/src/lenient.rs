//! Field readers that never fail a command: a missing field or one of the
//! wrong JSON type reads as absent, exactly like `as_str()` / `as_u64()` /
//! `as_bool()` on the raw value.

use serde::{de::DeserializeOwned, Deserialize, Deserializer};

/// `Some` only when the value has the expected JSON type.
pub fn opt<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let value = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value(value).ok())
}

/// A string, empty when missing or not a string.
pub fn string<'de, D>(d: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(opt(d)?.unwrap_or_default())
}

/// `Some` whenever the field is present (null included), wrapping the
/// lenient value; the field's `#[serde(default)]` covers absence.
pub fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    opt(d).map(Some)
}

/// The elements of an array, empty when missing or not an array.
pub fn array<'de, D>(d: D) -> Result<Vec<serde_json::Value>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(opt(d)?.unwrap_or_default())
}

/// A string that parses as a UUID (any form `Uuid::parse_str` accepts).
pub fn uuid<'de, D>(d: D) -> Result<Option<uuid::Uuid>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(opt::<D, String>(d)?.and_then(|s| uuid::Uuid::parse_str(&s).ok()))
}

/// An `i64`, zero when missing or not an integer (like `as_i64().unwrap_or(0)`).
pub fn i64_or_zero<'de, D>(d: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(opt::<D, i64>(d)?.unwrap_or(0))
}

/// An `i64` that also accepts a `u64` by wrapping (like
/// `as_i64().or(as_u64 as i64).unwrap_or(0)`). Matches the metrics extraction
/// exactly, including its wrapping of out-of-range `u64`s.
pub fn i64_wrap_or_zero<'de, D>(d: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    let v = serde_json::Value::deserialize(d)?;
    Ok(v.as_i64()
        .or_else(|| v.as_u64().map(|u| u as i64))
        .unwrap_or(0))
}

/// An `f32`, zero when missing or not a number (like
/// `as_f64().unwrap_or(0.0) as f32`).
pub fn f32_or_zero<'de, D>(d: D) -> Result<f32, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(opt::<D, f32>(d)?.unwrap_or(0.0))
}

/// A `user` field: trimmed, with empty or whitespace-only treated as absent
/// (like `as_str().map(trim).filter(!empty)`).
pub fn trimmed_non_empty(user: Option<String>) -> Option<String> {
    user.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Debug, Default, Deserialize)]
    struct I64Wrap {
        #[serde(default, deserialize_with = "super::i64_wrap_or_zero")]
        v: i64,
    }

    #[derive(Debug, Default, Deserialize)]
    struct I64Plain {
        #[serde(default, deserialize_with = "super::i64_or_zero")]
        v: i64,
    }

    #[derive(Debug, Default, Deserialize)]
    struct F32Val {
        #[serde(default, deserialize_with = "super::f32_or_zero")]
        v: f32,
    }

    fn wrap(v: serde_json::Value) -> i64 {
        serde_json::from_value::<I64Wrap>(v).unwrap().v
    }

    fn plain(v: serde_json::Value) -> i64 {
        serde_json::from_value::<I64Plain>(v).unwrap().v
    }

    fn f32v(v: serde_json::Value) -> f32 {
        serde_json::from_value::<F32Val>(v).unwrap().v
    }

    #[test]
    fn i64_wrap_or_zero_reads_signed_unsigned_and_wraps() {
        assert_eq!(wrap(json!({ "v": 7 })), 7);
        assert_eq!(wrap(json!({ "v": -7 })), -7);
        assert_eq!(wrap(json!({})), 0);
        assert_eq!(wrap(json!({ "v": null })), 0);
        assert_eq!(wrap(json!({ "v": "7" })), 0);
        assert_eq!(wrap(json!({ "v": 1.5 })), 0);
        assert_eq!(wrap(json!({ "v": true })), 0);
        // A u64 that fits reads as-is; one past i64::MAX wraps, like `as u64 as i64`.
        assert_eq!(wrap(json!({ "v": 9_223_372_036_854_775_807u64 })), i64::MAX);
        assert_eq!(
            wrap(json!({ "v": 18_446_744_073_709_551_615u64 })),
            u64::MAX as i64
        );
    }

    #[test]
    fn i64_or_zero_reads_integers_only() {
        assert_eq!(plain(json!({ "v": 7 })), 7);
        assert_eq!(plain(json!({})), 0);
        assert_eq!(plain(json!({ "v": null })), 0);
        assert_eq!(plain(json!({ "v": "7" })), 0);
        assert_eq!(plain(json!({ "v": 1.5 })), 0);
        assert_eq!(plain(json!({ "v": true })), 0);
    }

    #[test]
    fn f32_or_zero_reads_numbers_only() {
        assert_eq!(f32v(json!({ "v": 1.5 })), 1.5);
        assert_eq!(f32v(json!({ "v": 3 })), 3.0);
        assert_eq!(f32v(json!({})), 0.0);
        assert_eq!(f32v(json!({ "v": null })), 0.0);
        assert_eq!(f32v(json!({ "v": "1.5" })), 0.0);
        assert_eq!(f32v(json!({ "v": true })), 0.0);
    }

    #[test]
    fn trimmed_non_empty_trims_and_drops_blank() {
        assert_eq!(super::trimmed_non_empty(None), None);
        assert_eq!(super::trimmed_non_empty(Some(String::new())), None);
        assert_eq!(super::trimmed_non_empty(Some("   ".into())), None);
        assert_eq!(
            super::trimmed_non_empty(Some("  alice  ".into())),
            Some("alice".into())
        );
    }
}
