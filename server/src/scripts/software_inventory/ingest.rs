//! Typed software-inventory ingest: parse the raw snapshot entries once,
//! leniently, so the `db` function only binds parameters.
//!
//! Each entry deserializes exactly like the old `item["x"].as_str()` reads: a
//! missing or wrongly-typed field yields the same default / `None`. Entries
//! without a usable name are skipped, like the old insert loop did. The raw
//! entry JSON is still what the dispatch diff fans out to dashboards, so
//! unknown fields flow through untouched there.

use serde::Deserialize;

use crate::lenient;

/// One installed-software entry from a `software_inventory` snapshot.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SoftwareItem {
    /// Trimmed in [`SoftwareItem::parse`]; empty means "skip this entry".
    #[serde(default, deserialize_with = "lenient::string")]
    pub name: String,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub version: Option<String>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub publisher: Option<String>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub install_location: Option<String>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub install_date: Option<String>,
}

impl SoftwareItem {
    /// Parse one snapshot entry; `None` when it has no usable name, exactly
    /// like the old insert loop's skip.
    pub fn parse(v: &serde_json::Value) -> Option<Self> {
        let mut item: Self = serde_json::from_value(v.clone()).ok()?;
        item.name = item.name.trim().to_string();
        if item.name.is_empty() {
            return None;
        }
        Some(item)
    }

    /// The stable diff identity, exactly like the old `key_for_item`.
    pub fn key(&self) -> Option<String> {
        let name = self.name.trim();
        if name.is_empty() {
            return None;
        }
        // Keep the identity conservative to avoid flip-flopping.
        let version = self.version.as_deref().unwrap_or("").trim();
        let publisher = self.publisher.as_deref().unwrap_or("").trim();
        Some(format!(
            "{}\n{}\n{}",
            name.to_ascii_lowercase(),
            version.to_ascii_lowercase(),
            publisher.to_ascii_lowercase()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn software_item_parses_valid_input() {
        let item = SoftwareItem::parse(&json!({
            "name": "  Example App  ",
            "version": "1.2.3",
            "publisher": "Example Corp",
            "install_location": "C:\\Program Files\\Example",
            "install_date": "20240115",
        }))
        .expect("valid entry parses");
        // The stored name is trimmed, like the old insert loop.
        assert_eq!(item.name, "Example App");
        assert_eq!(item.version.as_deref(), Some("1.2.3"));
        assert_eq!(item.publisher.as_deref(), Some("Example Corp"));
        assert_eq!(
            item.install_location.as_deref(),
            Some("C:\\Program Files\\Example")
        );
        assert_eq!(item.install_date.as_deref(), Some("20240115"));
    }

    #[test]
    fn software_item_missing_name_is_skipped() {
        assert!(SoftwareItem::parse(&json!({ "version": "1.0" })).is_none());
    }

    #[test]
    fn software_item_blank_or_wrong_typed_name_is_skipped() {
        assert!(SoftwareItem::parse(&json!({ "name": "   " })).is_none());
        assert!(SoftwareItem::parse(&json!({ "name": 42 })).is_none());
        assert!(SoftwareItem::parse(&json!({ "name": ["app"] })).is_none());
    }

    #[test]
    fn software_item_wrong_typed_optionals_read_as_absent() {
        let item = SoftwareItem::parse(&json!({
            "name": "App",
            "version": 7,
            "publisher": false,
            "install_location": null,
            "install_date": ["2024"],
        }))
        .expect("name alone parses");
        assert_eq!(item.version, None);
        assert_eq!(item.publisher, None);
        assert_eq!(item.install_location, None);
        assert_eq!(item.install_date, None);
    }

    #[test]
    fn software_item_key_matches_old_identity() {
        let item = SoftwareItem::parse(&json!({
            "name": "  Example App ",
            "version": " 1.2.3 ",
            "publisher": "EXAMPLE Corp ",
        }))
        .expect("valid entry parses");
        assert_eq!(
            item.key().as_deref(),
            Some("example app\n1.2.3\nexample corp")
        );
    }

    #[test]
    fn software_item_key_ignores_missing_version_and_publisher() {
        let item = SoftwareItem::parse(&json!({ "name": "App" })).expect("parses");
        assert_eq!(item.key().as_deref(), Some("app\n\n"));
    }
}
