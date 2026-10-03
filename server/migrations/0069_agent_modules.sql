-- Device-owned module grants are reports, never server configuration.
CREATE TABLE agent_module_reports (
    agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    state JSONB NOT NULL,
    reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    conn_id UUID NOT NULL
);
CREATE TABLE agent_module_disable_requests (
    command_id UUID PRIMARY KEY,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    module TEXT NOT NULL,
    -- NUMERIC preserves the agent protocol's full unsigned u64 range.
    expected_revision NUMERIC(20,0) NOT NULL CHECK (expected_revision >= 0 AND expected_revision <= 18446744073709551615),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','disabled','duplicate','stale','conflict','error')),
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acknowledged_at TIMESTAMPTZ,
    last_sent_conn_id UUID,
    persisted BOOLEAN NOT NULL DEFAULT false,
    stop_status TEXT NOT NULL DEFAULT 'unconfirmed',
    stopped BOOLEAN NOT NULL DEFAULT false CHECK (stopped = false)
);
CREATE UNIQUE INDEX agent_module_one_pending_disable ON agent_module_disable_requests(agent_id,module) WHERE status IN ('queued','sent');
CREATE INDEX agent_module_disable_agent_created ON agent_module_disable_requests(agent_id,created_at DESC);
