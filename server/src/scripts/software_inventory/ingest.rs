//! Typed software-inventory ingest.
//!
//! `SoftwareItem` and its strict parser live once in `vantyr_protocol::telemetry`;
//! this module re-exports it for the `db` layer. Wrongly-typed fields reject the
//! whole snapshot; a nameless entry is the one legitimate skip.

pub use vantyr_protocol::telemetry::SoftwareItem;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn valid_entry_parses_and_keeps_its_identity() {
        let item = SoftwareItem::parse(&json!({
            "name": "  Example App  ", "version": " 1.2.3 ",
            "publisher": "EXAMPLE Corp ", "install_location": null, "install_date": null
        }))
        .unwrap()
        .unwrap();
        assert_eq!(item.name, "Example App");
        assert_eq!(item.key().as_deref(), Some("example app\n1.2.3\nexample corp"));
    }

    #[test]
    fn nameless_entries_skip_but_wrong_types_reject() {
        assert!(SoftwareItem::parse(&json!({"version":"1"})).is_err());
        assert!(SoftwareItem::parse(&json!({"name":"   "})).unwrap().is_none());
        assert!(SoftwareItem::parse(&json!({"name":42})).is_err());
        assert!(SoftwareItem::parse(&json!({"name":"App","version":7})).is_err());
        let item = SoftwareItem::parse(&json!({"name":"App","version":null}))
            .unwrap()
            .unwrap();
        assert_eq!(item.version, None);
        assert_eq!(item.key().as_deref(), Some("app\n\n"));
    }
}
