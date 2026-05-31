//! Validated server configuration from environment variables.
//!
//! Prefer `*_FILE` variants for secrets (Docker secrets); see `read_env_or_file` in `main.rs`.

use crate::trusted_proxy::TrustedProxies;
use std::net::SocketAddr;

/// Runtime configuration validated at startup.
#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub database_url: String,
    /// Parsed listen address (validated).
    pub listen: SocketAddr,
    pub static_dir: String,
    pub pool_max_connections: u32,
    /// Background retention job interval (seconds).
    pub retention_interval_secs: u64,
    /// Delete `alert_rule_events` (and screenshot blobs via FK) older than this many days. `None` = skip.
    pub alert_event_retention_days: Option<i64>,
    /// Delete `agent_software` rows with `captured_at` older than this many days. `None` = skip.
    pub software_inventory_retention_days: Option<i64>,
    /// Expose Prometheus metrics at `/metrics`.
    pub metrics_enabled: bool,
    /// Emit logs as JSON lines (easier for Loki/ELK). When false, uses compact human-readable logs.
    pub log_json: bool,
    /// 0 = disabled. Otherwise max requests per second per client IP (dashboard + API).
    pub api_rate_limit_per_second: u64,
    /// Reverse proxies whose `X-Forwarded-For`/`X-Real-IP`/`X-Forwarded-Proto` we trust for
    /// security decisions. Empty (default) trusts nobody and keys on the direct TCP peer.
    pub trusted_proxies: TrustedProxies,
}

fn read_env(name: &str) -> Option<String> {
    read_env_or_file(name).filter(|s| !s.trim().is_empty())
}

/// Same pattern as `main.rs`: value from `NAME` or raw contents of `NAME_FILE` (Docker secrets).
fn read_env_or_file(name: &str) -> Option<String> {
    if let Ok(val) = std::env::var(name) {
        return Some(val);
    }
    let file_key = format!("{name}_FILE");
    let path = std::env::var(file_key).ok()?;
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
}

fn parse_bool(s: &str) -> bool {
    matches!(
        s.trim(),
        "1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON"
    )
}

impl ServerConfig {
    /// Load and validate configuration. Fails fast on invalid values.
    pub fn from_env() -> anyhow::Result<Self> {
        let database_url = read_env_or_file("DATABASE_URL")
            .unwrap_or_else(|| "postgres://monitor:monitor@localhost:5432/monitor".to_string());
        if !database_url.starts_with("postgres://") && !database_url.starts_with("postgresql://") {
            anyhow::bail!("DATABASE_URL must be a postgres:// or postgresql:// connection string");
        }

        let listen_s =
            read_env_or_file("LISTEN_ADDR").unwrap_or_else(|| "0.0.0.0:9000".to_string());
        let listen: SocketAddr = listen_s
            .parse()
            .map_err(|e| anyhow::anyhow!("LISTEN_ADDR invalid ({listen_s}): {e}"))?;

        let static_dir = read_env_or_file("STATIC_DIR").unwrap_or_else(|| "./static".to_string());

        let pool_max_connections: u32 = read_env("POOL_MAX_CONNECTIONS")
            .map(|s| s.parse())
            .transpose()?
            .unwrap_or(20);
        if !(1..=200).contains(&pool_max_connections) {
            anyhow::bail!("POOL_MAX_CONNECTIONS must be between 1 and 200");
        }

        let retention_interval_secs: u64 = read_env("RETENTION_INTERVAL_SECS")
            .map(|s| s.parse())
            .transpose()?
            .unwrap_or(3600);
        if retention_interval_secs < 60 {
            anyhow::bail!("RETENTION_INTERVAL_SECS must be at least 60");
        }

        let alert_event_retention_days: Option<i64> = read_env("ALERT_EVENT_RETENTION_DAYS")
            .map(|s| s.parse())
            .transpose()?;
        if let Some(d) = alert_event_retention_days {
            if d < 1 {
                anyhow::bail!("ALERT_EVENT_RETENTION_DAYS must be >= 1 when set");
            }
        }

        let software_inventory_retention_days: Option<i64> =
            read_env("SOFTWARE_INVENTORY_RETENTION_DAYS")
                .map(|s| s.parse())
                .transpose()?;
        if let Some(d) = software_inventory_retention_days {
            if d < 1 {
                anyhow::bail!("SOFTWARE_INVENTORY_RETENTION_DAYS must be >= 1 when set");
            }
        }

        let metrics_enabled = read_env("METRICS_ENABLED").is_none_or(|v| parse_bool(&v));

        let log_json = read_env("LOG_JSON").is_some_and(|v| parse_bool(&v));

        let api_rate_limit_per_second: u64 = read_env("API_RATE_LIMIT_PER_SECOND")
            .map(|s| s.parse())
            .transpose()?
            .unwrap_or(0);

        let trusted_proxies = match read_env("TRUSTED_PROXY_CIDRS") {
            Some(s) => {
                let (tp, invalid) = TrustedProxies::parse_list(&s);
                if !invalid.is_empty() {
                    anyhow::bail!(
                        "TRUSTED_PROXY_CIDRS has invalid CIDR/IP entries: {}",
                        invalid.join(", ")
                    );
                }
                tp
            }
            None => TrustedProxies::default(),
        };

        Ok(Self {
            database_url,
            listen,
            static_dir,
            pool_max_connections,
            retention_interval_secs,
            alert_event_retention_days,
            software_inventory_retention_days,
            metrics_enabled,
            log_json,
            api_rate_limit_per_second,
            trusted_proxies,
        })
    }
}
