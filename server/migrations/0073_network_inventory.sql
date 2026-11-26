-- Migration 0073: Vantyr Network household inventory and explicit grants.
--
-- Scope is the household, never the platform operator role. Access is granted
-- only through rows in `network_grants`; no role, IP, username or device
-- ownership implies a network grant. This migration creates tables only: it
-- adds no grants, touches no agent credentials/module grants and writes no
-- Recall settings. The first household and its grant are created by the
-- authenticated, audited one-time bootstrap endpoint.

CREATE TABLE IF NOT EXISTS network_households (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT        NOT NULL,
    is_default BOOLEAN     NOT NULL DEFAULT false,
    created_by UUID        NULL REFERENCES dashboard_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT network_households_name_not_blank CHECK (length(trim(name)) > 0)
);
-- At most one default household can ever exist. Enforced in the schema so the
-- bootstrap transaction cannot race a second default into place.
CREATE UNIQUE INDEX IF NOT EXISTS network_households_single_default
    ON network_households (is_default) WHERE is_default;

CREATE TABLE IF NOT EXISTS network_persons (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    display_name TEXT        NOT NULL,
    note         TEXT        NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (id, household_id),
    CONSTRAINT network_persons_display_name_not_blank CHECK (length(trim(display_name)) > 0)
);
CREATE INDEX IF NOT EXISTS idx_network_persons_household
    ON network_persons (household_id, created_at DESC);

-- Devices are global inventory: one physical device may be assigned in
-- several households. `canonical_key` is normalized by the API before insert.
CREATE TABLE IF NOT EXISTS network_devices (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_key TEXT        NOT NULL UNIQUE,
    label         TEXT        NOT NULL,
    device_type   TEXT        NOT NULL DEFAULT 'unknown'
        CHECK (device_type IN ('computer','phone','tablet','router','switch','ap','tv','iot','other','unknown')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT network_devices_label_not_blank CHECK (length(trim(label)) > 0),
    CONSTRAINT network_devices_key_not_blank CHECK (length(trim(canonical_key)) > 0)
);

-- Explicit enrollment of an already-existing agent into a household. This is
-- the only way an agent may be correlated with a household: never by IP,
-- hostname, username or token. An agent belongs to at most one household.
CREATE TABLE IF NOT EXISTS network_household_agents (
    household_id UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    agent_id     UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    enrolled_by  UUID        NULL REFERENCES dashboard_users(id) ON DELETE SET NULL,
    enrolled_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (household_id, agent_id),
    UNIQUE (agent_id, household_id),
    UNIQUE (agent_id)
);

-- A person may hold several device assignments; a shared device may be
-- assigned to several persons. Composite FKs keep person and enrolled agent
-- inside the same household as the assignment.
CREATE TABLE IF NOT EXISTS network_assignments (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    person_id    UUID        NOT NULL,
    device_id    UUID        NOT NULL REFERENCES network_devices(id) ON DELETE CASCADE,
    agent_id     UUID        NULL,
    role         TEXT        NOT NULL DEFAULT 'member'
        CHECK (role IN ('owner','member','guest','managed','unknown')),
    note         TEXT        NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (id, household_id),
    FOREIGN KEY (person_id, household_id)
        REFERENCES network_persons(id, household_id) ON DELETE CASCADE,
    -- MATCH SIMPLE: a NULL agent_id skips this FK, so the link stays optional.
    -- NO ACTION: unenrolling an agent requires clearing its assignments first,
    -- while a household cascade can still remove both rows in one statement.
    FOREIGN KEY (agent_id, household_id)
        REFERENCES network_household_agents(agent_id, household_id) ON DELETE NO ACTION
);
CREATE INDEX IF NOT EXISTS idx_network_assignments_household
    ON network_assignments (household_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_network_assignments_device
    ON network_assignments (device_id, household_id);

-- Observed connections. `kind` is provenance-tagged (agent / dns / proxy);
-- `provenance`, `capabilities` and `status` are recorded facts, never an
-- instruction to a worker and never enforcement state. No runtime component
-- reads these rows in this slice.
CREATE TABLE IF NOT EXISTS network_connections (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id  UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    assignment_id UUID        NOT NULL,
    kind          TEXT        NOT NULL CHECK (kind IN ('agent','dns','proxy')),
    provenance    TEXT        NOT NULL DEFAULT 'manual'
        CHECK (provenance IN ('manual','agent','dns','proxy','import')),
    capabilities  JSONB       NOT NULL DEFAULT '[]'::jsonb,
    status        TEXT        NOT NULL DEFAULT 'unknown'
        CHECK (status IN ('unknown','active','inactive','stale','error')),
    observed_at   TIMESTAMPTZ NULL,
    note          TEXT        NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (id, household_id),
    FOREIGN KEY (assignment_id, household_id)
        REFERENCES network_assignments(id, household_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_network_connections_household
    ON network_connections (household_id, kind, created_at DESC);

-- Explicit, household-scoped grants. Only these rows authorize network API
-- access. There is deliberately no role-derived or wildcard grant.
CREATE TABLE IF NOT EXISTS network_grants (
    household_id UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    user_id      UUID        NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
    grant_name   TEXT        NOT NULL CHECK (grant_name IN ('network_admin','network_events')),
    granted_by   UUID        NULL REFERENCES dashboard_users(id) ON DELETE SET NULL,
    granted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (household_id, user_id, grant_name)
);
CREATE INDEX IF NOT EXISTS idx_network_grants_user
    ON network_grants (user_id, household_id);
