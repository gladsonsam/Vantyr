//! Bounded, single-snapshot fleet enrichment. No commands or database writes.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct FleetWindow {
    pub app: String,
    pub title: String,
    pub reported_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct FleetAgentSummary {
    /// Sanitized by [`sanitize_fleet_info`]; typed as the shape that allowlist keeps.
    #[ts(as = "Option<crate::agents::info_shape::AgentInfo>")]
    pub info: Option<serde_json::Value>,
    pub info_reported_at: Option<DateTime<Utc>>,
    pub last_window: Option<FleetWindow>,
    pub internet_blocked: bool,
    /// Scope of the always-on rule that applies: `all`, `group` or `agent`.
    #[ts(type = "\"all\" | \"group\" | \"agent\" | null")]
    pub internet_block_source: Option<String>,
    pub app_block_enabled_count: i64,
}

// Each telemetry lookup is an indexed top-one, never a fleet-wide window scan.
// EXISTS avoids double-counting rules with overlapping scopes/groups. One SQL
// statement also means policy and telemetry reads share a PostgreSQL snapshot.
pub(crate) const FLEET_SUMMARY_SQL: &str = r"
SELECT a.id, i.info, i.updated_at AS info_reported_at,
       w.app, w.title, w.ts AS window_reported_at,
       net.scope_kind AS internet_block_source,
       apps.enabled_count AS app_block_enabled_count
FROM agents a
LEFT JOIN agent_info i ON i.agent_id = a.id
LEFT JOIN LATERAL (
    SELECT app, title, ts FROM window_events
    WHERE agent_id = a.id ORDER BY ts DESC, id DESC LIMIT 1
) w ON TRUE
LEFT JOIN LATERAL (
    SELECT s.scope_kind FROM internet_block_rule_scopes s
    JOIN internet_block_rules r ON r.id = s.rule_id
    WHERE r.enabled
      AND NOT EXISTS (SELECT 1 FROM internet_block_rule_schedules sch WHERE sch.rule_id = r.id)
      AND (s.scope_kind = 'all'
        OR (s.scope_kind = 'agent' AND s.agent_id = a.id)
        OR (s.scope_kind = 'group' AND EXISTS (
            SELECT 1 FROM agent_group_members m WHERE m.agent_id = a.id AND m.group_id = s.group_id)))
    ORDER BY CASE s.scope_kind WHEN 'all' THEN 1 WHEN 'group' THEN 2 ELSE 3 END
    LIMIT 1
) net ON TRUE
LEFT JOIN LATERAL (
    SELECT COUNT(*) AS enabled_count FROM app_block_rules r
    WHERE r.enabled AND EXISTS (
        SELECT 1 FROM app_block_rule_scopes s WHERE s.rule_id = r.id
        AND (s.scope_kind = 'all'
          OR (s.scope_kind = 'agent' AND s.agent_id = a.id)
          OR (s.scope_kind = 'group' AND EXISTS (
              SELECT 1 FROM agent_group_members m WHERE m.agent_id = a.id AND m.group_id = s.group_id))))
) apps ON TRUE
WHERE a.id = ANY($1)
ORDER BY a.id
";

/// One [`FLEET_SUMMARY_SQL`] row. The SQL stays a runtime query because the plan
/// test runs `EXPLAIN` on the same constant.
#[derive(sqlx::FromRow)]
struct FleetSummaryRow {
    id: Uuid,
    info: Option<serde_json::Value>,
    info_reported_at: Option<DateTime<Utc>>,
    app: Option<String>,
    title: Option<String>,
    window_reported_at: Option<DateTime<Utc>>,
    internet_block_source: Option<String>,
    app_block_enabled_count: i64,
}

pub async fn fleet_summary_batch(
    pool: &PgPool,
    ids: &[Uuid],
) -> Result<BTreeMap<Uuid, FleetAgentSummary>> {
    anyhow::ensure!(ids.len() <= 100, "Fleet summary supports at most 100 IDs");
    let rows = sqlx::query_as::<_, FleetSummaryRow>(FLEET_SUMMARY_SQL)
        .bind(ids)
        .fetch_all(pool)
        .await?;
    let mut out = BTreeMap::new();
    for row in rows {
        let info = row.info.as_ref().and_then(sanitize_fleet_info);
        let source = row.internet_block_source;
        out.insert(
            row.id,
            FleetAgentSummary {
                info_reported_at: if info.is_some() {
                    row.info_reported_at
                } else {
                    None
                },
                info,
                // `app`/`title` are NOT NULL, so they are present whenever a window row is.
                last_window: match (row.window_reported_at, row.app, row.title) {
                    (Some(reported_at), Some(app), Some(title)) => Some(FleetWindow {
                        app,
                        title,
                        reported_at,
                    }),
                    _ => None,
                },
                internet_blocked: source.is_some(),
                internet_block_source: source,
                app_block_enabled_count: row.app_block_enabled_count,
            },
        );
    }
    Ok(out)
}

/// Preserve the public agent-info shape, never serialize arbitrary reported
/// config objects, tokens, hashes or unknown nested fields. Agent-reported data
/// is untrusted; known scalar fields cannot smuggle structured config either.
pub(crate) fn sanitize_fleet_info(raw: &serde_json::Value) -> Option<serde_json::Value> {
    use serde_json::{Map, Value};
    fn fields(raw: &Value, keys: &[&str]) -> Map<String, Value> {
        let mut out = Map::new();
        for key in keys {
            if let Some(value) = raw.get(*key) {
                // All allowlisted keys have a declared scalar type. A scalar
                // of the wrong type is just as untrusted as a nested object.
                let number = matches!(
                    *key,
                    "uptime_secs"
                        | "cpu_cores"
                        | "memory_total_mb"
                        | "memory_used_mb"
                        | "ts"
                        | "total_gb"
                        | "available_gb"
                        | "index"
                        | "width"
                        | "height"
                        | "x"
                        | "y"
                        | "physical_width"
                        | "physical_height"
                );
                let boolean = matches!(
                    *key,
                    "config_ui_password_set"
                        | "machine_connection_policy"
                        | "primary"
                        | "geometry_available"
                );
                let nullable = matches!(
                    *key,
                    "os_version"
                        | "os_long_version"
                        | "kernel_version"
                        | "install_path"
                        | "x"
                        | "y"
                        | "physical_width"
                        | "physical_height"
                );
                let valid = if value.is_null() {
                    nullable
                } else if number {
                    value.as_f64().is_some_and(f64::is_finite)
                } else if boolean {
                    value.is_boolean()
                } else {
                    value.is_string()
                };
                if valid {
                    let value = match value {
                        Value::String(s) => Value::String(s.chars().take(8192).collect()),
                        other => other.clone(),
                    };
                    out.insert((*key).into(), value);
                }
            }
        }
        out
    }
    raw.as_object()?;
    let mut out = fields(
        raw,
        &[
            "agent_version",
            "hostname",
            "timezone",
            "uptime_secs",
            "system_model",
            "system_manufacturer",
            "system_serial",
            "motherboard_model",
            "motherboard_manufacturer",
            "os_name",
            "os_version",
            "os_long_version",
            "kernel_version",
            "cpu_brand",
            "cpu_cores",
            "memory_total_mb",
            "memory_used_mb",
            "config_path",
            "machine_config_path",
            "machine_connection_policy",
            "install_path",
            "config_agent_name",
            "config_ui_password_set",
            "current_user",
            "ts",
        ],
    );
    if let Some(url) = raw
        .get("config_server_url")
        .and_then(Value::as_str)
        .filter(|s| s.len() <= 8192)
        .and_then(|s| url::Url::parse(s).ok())
    {
        let mut url = url;
        if matches!(url.scheme(), "http" | "https" | "ws" | "wss") {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            out.insert("config_server_url".into(), Value::String(url.to_string()));
        }
    }
    for (name, keys) in [
        (
            "drives",
            &[
                "name",
                "mount_point",
                "file_system",
                "total_gb",
                "available_gb",
            ][..],
        ),
        ("adapters", &["name", "description", "mac"][..]),
        (
            "monitors",
            &[
                "index",
                "name",
                "width",
                "height",
                "primary",
                "x",
                "y",
                "physical_width",
                "physical_height",
                "geometry_available",
            ][..],
        ),
    ] {
        if let Some(items) = raw.get(name).and_then(Value::as_array) {
            let items = items
                .iter()
                .take(64)
                .filter(|v| v.is_object())
                .map(|v| {
                    let mut item = fields(v, keys);
                    if name == "adapters" {
                        for key in ["ips", "gateways", "dns"] {
                            if let Some(values) = v.get(key).and_then(Value::as_array) {
                                item.insert(
                                    key.into(),
                                    Value::Array(
                                        values
                                            .iter()
                                            .take(64)
                                            .filter_map(Value::as_str)
                                            .map(|s| Value::String(s.chars().take(256).collect()))
                                            .collect(),
                                    ),
                                );
                            }
                        }
                    }
                    Value::Object(item)
                })
                .collect();
            out.insert(name.into(), Value::Array(items));
        }
    }
    if let Some(c) = raw.get("capabilities").filter(|v| v.is_object()) {
        out.insert(
            "capabilities".into(),
            Value::Object(fields(
                c,
                &[
                    "platform",
                    "session_type",
                    "desktop",
                    "screen_capture",
                    "audio_capture",
                    "remote_input",
                    "keyboard_monitor",
                    "url_tracking",
                    "active_window",
                    "software_inventory",
                    "terminal",
                    "script_execution",
                    "app_blocking",
                    "network_blocking",
                    "system_control",
                ],
            )),
        );
    }
    Some(Value::Object(out))
}
