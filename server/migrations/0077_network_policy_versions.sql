-- Migration 0077: durable, versioned network policy and explicit gateway
-- desired assignment, plus a scoped `read_policy` worker command.
--
-- Additive and latest: 0073..0076 and their checksums are unchanged. Nothing
-- here reads or writes agent tokens, agent modules, module grants, Recall
-- settings, DHCP/router state or any control/runtime table.
--
-- A saved policy or gateway assignment is ONLY a proposed desired state. There
-- is deliberately no applied/enforced column and no ack/canary state: a worker
-- fetch is retrieval, not proof that anything was put into effect. Rollback
-- creates a NEW monotonic revision; nothing is ever reset or overwritten.

-- ─── Immutable, versioned policy rows ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS network_policies (
    household_id              UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    revision                  BIGINT      NOT NULL CHECK (revision >= 1),
    schema_version            INTEGER     NOT NULL CHECK (schema_version = 1),
    -- Canonical serde bytes of the typed Policy. Stored exactly as hashed.
    body                      BYTEA       NOT NULL,
    -- SHA-256 of `body`, maintained by the server helper. A content digest,
    -- NOT a signature and NOT a claim of worker verification.
    body_sha256               TEXT        NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
    source_kind               TEXT        NOT NULL CHECK (source_kind IN ('publish', 'rollback')),
    rolled_back_from_revision BIGINT      NULL,
    published_at              TIMESTAMPTZ NOT NULL,
    published_by              UUID        NULL REFERENCES dashboard_users(id) ON DELETE SET NULL,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (household_id, revision),
    CONSTRAINT network_policies_body_bounded CHECK (octet_length(body) BETWEEN 1 AND 65536),
    CONSTRAINT network_policies_rollback_pin CHECK (
        (source_kind = 'rollback' AND rolled_back_from_revision IS NOT NULL)
        OR (source_kind = 'publish' AND rolled_back_from_revision IS NULL)
    )
);

-- Rows are immutable: every publish/rollback INSERTs a new revision. Old,
-- UNPINNED rows may be pruned to bound history; pinned (desired/current/
-- rollback-source) rows are never pruned.
CREATE OR REPLACE FUNCTION network_policies_forbid_update() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'network policy versions are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER network_policies_no_update
    BEFORE UPDATE ON network_policies
    FOR EACH ROW EXECUTE FUNCTION network_policies_forbid_update();

CREATE INDEX IF NOT EXISTS idx_network_policies_household_revision
    ON network_policies (household_id, revision DESC);

COMMENT ON COLUMN network_policies.body IS
    'Canonical serde bytes of the typed Policy. Immutable; digest is body_sha256.';
COMMENT ON COLUMN network_policies.body_sha256 IS
    'SHA-256 content digest of stored bytes. Not a signature or verification claim.';

-- ─── Explicit desired assignment (proposed only) ────────────────────────────

CREATE TABLE IF NOT EXISTS network_gateway_desired_policy (
    household_id UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    gateway_id   UUID        NOT NULL,
    kind         TEXT        NOT NULL CHECK (kind IN ('dns', 'proxy')),
    revision     BIGINT      NOT NULL CHECK (revision >= 1),
    assigned_by  UUID        NULL REFERENCES dashboard_users(id) ON DELETE SET NULL,
    assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (household_id, gateway_id),
    UNIQUE (household_id, gateway_id, kind),
    -- Storage pins the assignment to a live gateway of the SAME kind.
    FOREIGN KEY (gateway_id, household_id, kind)
        REFERENCES network_gateways(id, household_id, kind) ON DELETE CASCADE,
    -- A pinned revision cannot be pruned out from under an assignment.
    FOREIGN KEY (household_id, revision)
        REFERENCES network_policies(household_id, revision) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_network_desired_policy_household
    ON network_gateway_desired_policy (household_id, gateway_id);

COMMENT ON TABLE network_gateway_desired_policy IS
    'Saved/proposed desired revision for a same-household, same-kind gateway. No applied/enforced state exists.';

-- ─── Explicit, opt-in worker command scope ──────────────────────────────────

-- The old constraint allowed ONLY 'heartbeat'. Replacing it (not editing 0075)
-- adds the explicit 'read_policy' command. Existing heartbeat credentials are
-- untouched by this migration: no row is updated, so no existing credential
-- gains the new command automatically. Issuance must request it explicitly.
ALTER TABLE network_gateway_credentials
    DROP CONSTRAINT IF EXISTS network_gateway_commands_bounded;
ALTER TABLE network_gateway_credentials
    ADD CONSTRAINT network_gateway_commands_bounded CHECK (
        cardinality(allowed_commands) BETWEEN 1 AND 8
        AND allowed_commands <@ ARRAY['heartbeat', 'read_policy']::text[]
    );

COMMENT ON COLUMN network_gateway_credentials.allowed_commands IS
    'Explicit command allowlist: heartbeat and/or read_policy. Default is heartbeat; scope is never widened implicitly.';
