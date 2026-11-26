-- Migration 0075: Vantyr Network gateways (DNS / Proxy) and worker credentials.
--
-- Additive and latest: 0073 and 0074 stay immutable. Nothing here reads or
-- writes agent api-token hashes, agent modules, module grants, Recall settings
-- or any control/runtime table. A gateway is a household-owned inventory object
-- with a server-generated immutable id; worker credentials are separate,
-- household+gateway+kind-scoped bearer identities used for ONE purpose in this
-- slice: posting a bounded heartbeat report.
--
-- Reported capabilities / last_seen_at / revisions / failures are UNVERIFIED
-- observations. The schema forbids flipping `verified` or `enforced` to true so
-- saving a report can never be mistaken for policy enforcement or a canary ack.

CREATE TABLE IF NOT EXISTS network_gateways (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    kind         TEXT        NOT NULL CHECK (kind IN ('dns', 'proxy')),
    label        TEXT        NOT NULL,
    enabled      BOOLEAN     NOT NULL DEFAULT true,
    -- Allowlisted, worker-reported capability strings. Unverified by design.
    capabilities JSONB       NOT NULL DEFAULT '[]'::jsonb,
    -- Worker-reported last-seen time. Unverified: never proof of enforcement.
    last_seen_at TIMESTAMPTZ NULL,
    revoked_at   TIMESTAMPTZ NULL,
    created_by   UUID        NULL REFERENCES dashboard_users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT network_gateways_label_not_blank CHECK (length(trim(label)) > 0),
    CONSTRAINT network_gateways_label_len CHECK (length(label) <= 120),
    -- Composite keys exist so children can carry an FK that pins every scope.
    UNIQUE (id, household_id),
    UNIQUE (id, household_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_network_gateways_household_kind
    ON network_gateways (household_id, kind, created_at DESC);

COMMENT ON COLUMN network_gateways.capabilities IS
    'Worker-reported, allowlisted capability strings. Unverified observation; no runtime acts on them.';
COMMENT ON COLUMN network_gateways.last_seen_at IS
    'Worker-reported last heartbeat time. Unverified; never proof that policy was applied.';

-- A credential is NOT an agent token. Only a 64-hex SHA-256 digest of a
-- high-entropy secret is stored; the plaintext is returned once at issuance and
-- never persisted. The token id (this row's id) is a non-secret identifier.
CREATE TABLE IF NOT EXISTS network_gateway_credentials (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id     UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    gateway_id       UUID        NOT NULL,
    kind             TEXT        NOT NULL CHECK (kind IN ('dns', 'proxy')),
    audience         TEXT        NOT NULL CHECK (audience = 'vantyr-gateway-worker'),
    allowed_commands TEXT[]      NOT NULL DEFAULT ARRAY['heartbeat']::text[],
    secret_hash      TEXT        NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
    expires_at       TIMESTAMPTZ NOT NULL,
    revoked_at       TIMESTAMPTZ NULL,
    last_used_at     TIMESTAMPTZ NULL,
    issued_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    issued_by        UUID        NULL REFERENCES dashboard_users(id) ON DELETE SET NULL,
    rotated_from     UUID        NULL REFERENCES network_gateway_credentials(id) ON DELETE SET NULL,
    CONSTRAINT network_gateway_credentials_expiry CHECK (expires_at > issued_at),
    CONSTRAINT network_gateway_commands_bounded CHECK (
        cardinality(allowed_commands) BETWEEN 1 AND 8
        AND allowed_commands <@ ARRAY['heartbeat']::text[]
    ),
    UNIQUE (id, household_id, gateway_id),
    UNIQUE (secret_hash),
    -- Pin household and kind at the storage layer, not just in application code.
    FOREIGN KEY (gateway_id, household_id, kind)
        REFERENCES network_gateways(id, household_id, kind) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_gateway_credentials_scope
    ON network_gateway_credentials (household_id, gateway_id, revoked_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gateway_credentials_active_secret
    ON network_gateway_credentials (secret_hash) WHERE revoked_at IS NULL;

COMMENT ON COLUMN network_gateway_credentials.secret_hash IS
    'SHA-256 digest of a 256-bit random secret. The plaintext is shown once and never stored.';

-- Append-only reports. Each row is bound to the same household AND gateway AND
-- credential, so a worker can never report into a scope it does not hold.
CREATE TABLE IF NOT EXISTS network_gateway_reports (
    id               BIGSERIAL   PRIMARY KEY,
    household_id     UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    gateway_id       UUID        NOT NULL,
    credential_id    UUID        NOT NULL,
    reported_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    observed_at      TIMESTAMPTZ NOT NULL,
    capabilities     JSONB       NOT NULL DEFAULT '[]'::jsonb,
    desired_revision TEXT        NULL,
    applied_revision TEXT        NULL,
    failure          TEXT        NULL,
    -- These columns are always false: a self-report is not verification.
    verified         BOOLEAN     NOT NULL DEFAULT false CHECK (verified = false),
    enforced         BOOLEAN     NOT NULL DEFAULT false CHECK (enforced = false),
    CONSTRAINT network_gateway_revisions_bounded CHECK (
        (desired_revision IS NULL OR length(desired_revision) <= 64)
        AND (applied_revision IS NULL OR length(applied_revision) <= 64)
        AND (failure IS NULL OR length(failure) <= 200)
    ),
    FOREIGN KEY (gateway_id, household_id)
        REFERENCES network_gateways(id, household_id) ON DELETE CASCADE,
    FOREIGN KEY (credential_id, household_id, gateway_id)
        REFERENCES network_gateway_credentials(id, household_id, gateway_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_gateway_reports_scope
    ON network_gateway_reports (household_id, gateway_id, reported_at DESC, id DESC);

COMMENT ON COLUMN network_gateway_reports.verified IS
    'Always false. A worker report is never accepted as independent verification.';
COMMENT ON COLUMN network_gateway_reports.enforced IS
    'Always false. Saving a reported desired/applied revision is not policy enforcement or a canary ack.';
