-- Bounded deterministic top-one lookups, including equal-timestamp events.
-- Replace the prefix index: this index also serves existing agent/ts queries.
CREATE INDEX IF NOT EXISTS idx_window_events_agent_ts_id
    ON window_events (agent_id, ts DESC, id DESC);
DROP INDEX IF EXISTS idx_window_events_agent_ts;
