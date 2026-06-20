-- Migration 0057: monitoring alert channels (agent offline + resource threshold)
--
-- Extends the alert_rules engine beyond content matching:
--   channel='resource'      → metric/comparator/threshold (e.g. cpu_pct > 90)
--   channel='agent_offline' → duration_secs (fire when offline >= N seconds)
-- For these channels `pattern`/`match_mode` are unused (the API sends empty).

ALTER TABLE alert_rules
    DROP CONSTRAINT IF EXISTS alert_rules_channel_check;

ALTER TABLE alert_rules
    ADD CONSTRAINT alert_rules_channel_check
    CHECK (channel IN ('url', 'keys', 'url_category', 'agent_offline', 'resource'));

ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS metric        TEXT;  -- cpu_pct | mem_pct | disk_pct
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS comparator    TEXT;  -- gt | lt
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS threshold     REAL;  -- percent (0-100)
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS duration_secs INT;   -- offline grace / sustained breach
