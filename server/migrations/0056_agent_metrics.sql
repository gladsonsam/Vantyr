-- Migration 0056: resource metrics time-series (health history)
--
-- The agent samples CPU / memory / system-disk on a fixed cadence (default 60s)
-- and streams a "metrics" frame. Stored here for charts and threshold alerts.
-- Pruned by SCRIPT-style age retention (METRICS_RETENTION_DAYS, default 90).

CREATE TABLE IF NOT EXISTS agent_metrics (
    agent_id      UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cpu_pct       REAL        NOT NULL,
    mem_used_mb   BIGINT      NOT NULL,
    mem_total_mb  BIGINT      NOT NULL,
    mem_pct       REAL        NOT NULL,
    disk_pct      REAL        NOT NULL,
    disk_used_gb  REAL        NOT NULL,
    disk_total_gb REAL        NOT NULL
);

-- Serves both the per-agent time-range chart reads and the age-based prune.
CREATE INDEX IF NOT EXISTS idx_agent_metrics_agent_ts
    ON agent_metrics (agent_id, ts DESC);
