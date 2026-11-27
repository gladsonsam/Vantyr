-- Migration 0083: centrally issued proxy sign-in credentials, sessions and
-- single-use session evidence, plus an explicit opt-in worker command.
--
-- Additive and latest. 0081 (DNS events) and 0082 (DNS settings) are reserved
-- and untouched; no existing migration, checksum, grant row or runtime table
-- is changed. No CA/PKI, DNS, events, cache, router or global-audit table is
-- added. This migration creates only the proxy authority tables and widens the
-- gateway command *allowlist* (never any existing credential row).
--
-- Secrets are 256-bit random values retained only as 64-hex SHA-256 digests.
-- The plaintext is returned once at issuance and never persisted or listed.
-- Person and device ids are pinned to the household by composite foreign keys;
-- a label is display metadata only, never an identity or policy input.

-- ─── Explicit opt-in worker command (no row is updated) ───────────────────────

ALTER TABLE network_gateway_credentials
    DROP CONSTRAINT IF EXISTS network_gateway_commands_bounded;
ALTER TABLE network_gateway_credentials
    ADD CONSTRAINT network_gateway_commands_bounded CHECK (
        cardinality(allowed_commands) BETWEEN 1 AND 8
        AND allowed_commands <@ ARRAY[
            'heartbeat', 'read_policy', 'read_dns_management',
            'report_dns_status', 'introspect_proxy'
        ]::text[]
    );

COMMENT ON COLUMN network_gateway_credentials.allowed_commands IS
    'Explicit command allowlist. Default issuance stays heartbeat-only; new commands are never added to existing rows.';

-- ─── Proxy sign-in credentials ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS network_proxy_credentials (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id       UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    person_id          UUID        NOT NULL,
    device_id          UUID        NOT NULL,
    label              TEXT        NOT NULL,
    scopes             TEXT[]      NOT NULL DEFAULT ARRAY['proxy_connect','proxy_http']::text[],
    secret_hash        TEXT        NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
    binding_generation BIGINT      NOT NULL CHECK (binding_generation > 0),
    household_kind     TEXT        NOT NULL CHECK (household_kind IN ('personal','shared')),
    issued_by          UUID        NULL REFERENCES dashboard_users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at         TIMESTAMPTZ NOT NULL,
    last_used_at       TIMESTAMPTZ NULL,
    revoked_at         TIMESTAMPTZ NULL,
    CONSTRAINT network_proxy_credentials_expiry CHECK (expires_at > created_at),
    CONSTRAINT network_proxy_credentials_label CHECK (length(trim(label)) BETWEEN 1 AND 80),
    CONSTRAINT network_proxy_credentials_scopes CHECK (
        cardinality(scopes) BETWEEN 1 AND 8
        AND scopes <@ ARRAY['proxy_connect','proxy_http']::text[]
    ),
    UNIQUE (id, household_id),
    UNIQUE (secret_hash),
    FOREIGN KEY (person_id, household_id)
        REFERENCES network_persons(id, household_id) ON DELETE CASCADE,
    FOREIGN KEY (device_id, household_id)
        REFERENCES network_devices(id, household_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_proxy_credentials_household
    ON network_proxy_credentials (household_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proxy_credentials_person
    ON network_proxy_credentials (household_id, person_id, revoked_at);

COMMENT ON COLUMN network_proxy_credentials.secret_hash IS
    'SHA-256 digest of a 256-bit random secret. Plaintext is shown once and never stored.';
COMMENT ON COLUMN network_proxy_credentials.person_id IS
    'Explicitly resolved household person from the OIDC-backed session; not inferred from a label, IP or body claim.';
COMMENT ON COLUMN network_proxy_credentials.device_id IS
    'Concrete household device derived from the OIDC-backed session; the exact binding the worker verifies.';

-- ─── Proxy sessions (observations of a verified sign-in, never coverage) ──────

CREATE TABLE IF NOT EXISTS network_proxy_sessions (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id       UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    credential_id      UUID        NOT NULL,
    device_id          UUID        NOT NULL,
    person_id          UUID        NOT NULL,
    binding_generation BIGINT      NOT NULL CHECK (binding_generation > 0),
    household_kind     TEXT        NOT NULL CHECK (household_kind IN ('personal','shared')),
    started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at         TIMESTAMPTZ NOT NULL,
    ended_at           TIMESTAMPTZ NULL,
    end_reason         TEXT        NULL CHECK (end_reason IN (
        'credential_revoked', 'session_ended', 'session_ended_all', 'expired'
    )),
    CONSTRAINT network_proxy_sessions_expiry CHECK (expires_at > started_at),
    UNIQUE (id, household_id),
    FOREIGN KEY (credential_id, household_id)
        REFERENCES network_proxy_credentials(id, household_id) ON DELETE CASCADE,
    FOREIGN KEY (device_id, household_id)
        REFERENCES network_devices(id, household_id) ON DELETE CASCADE,
    FOREIGN KEY (person_id, household_id)
        REFERENCES network_persons(id, household_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_proxy_sessions_household
    ON network_proxy_sessions (household_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_proxy_sessions_credential
    ON network_proxy_sessions (household_id, credential_id, ended_at);

COMMENT ON TABLE network_proxy_sessions IS
    'A recorded verified sign-in observation. No enforcement, inspection, DNS coverage or applied-policy flag exists.';

-- ─── Single-use session evidence ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS network_proxy_session_evidence (
    session_id         UUID        PRIMARY KEY,
    household_id       UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    credential_id      UUID        NOT NULL,
    device_id          UUID        NOT NULL,
    person_id          UUID        NULL,
    binding_generation BIGINT      NOT NULL CHECK (binding_generation > 0),
    household_kind     TEXT        NOT NULL CHECK (household_kind IN ('personal','shared')),
    command            TEXT        NOT NULL CHECK (command IN ('proxy_connect','proxy_http')),
    digest             TEXT        NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
    nonce              TEXT        NOT NULL CHECK (length(nonce) BETWEEN 1 AND 64),
    issued_at          TIMESTAMPTZ NOT NULL,
    expires_at         TIMESTAMPTZ NOT NULL,
    revoked_at         TIMESTAMPTZ NULL,
    consumed_at        TIMESTAMPTZ NULL,
    CONSTRAINT network_proxy_evidence_expiry CHECK (expires_at > issued_at),
    UNIQUE (digest),
    UNIQUE (household_id, nonce),
    FOREIGN KEY (credential_id, household_id)
        REFERENCES network_proxy_credentials(id, household_id) ON DELETE CASCADE,
    FOREIGN KEY (device_id, household_id)
        REFERENCES network_devices(id, household_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_proxy_evidence_credential
    ON network_proxy_session_evidence (household_id, credential_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_proxy_evidence_replay
    ON network_proxy_session_evidence (household_id, consumed_at, expires_at);

COMMENT ON COLUMN network_proxy_session_evidence.digest IS
    'SHA-256 of the canonical evidence bytes; recomputed and compared in constant time at introspection.';
COMMENT ON COLUMN network_proxy_session_evidence.person_id IS
    'Derived from the authoritative OIDC-backed session, never chosen by the evidence requester.';
COMMENT ON TABLE network_proxy_session_evidence IS
    'Replay state lives on the receipt row and survives pruning of other rows until its own expiry plus retention.';
