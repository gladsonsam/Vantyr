-- Pending agent enrollment claims and pairing-code invites.

CREATE TABLE IF NOT EXISTS agent_enrollment_invites (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    secret_digest    TEXT NOT NULL UNIQUE,
    kind             TEXT NOT NULL CHECK (kind IN ('quick_pair', 'unattended', 're_enroll')),
    uses_remaining   INTEGER NOT NULL DEFAULT 1 CHECK (uses_remaining >= 0),
    expires_at       TIMESTAMPTZ NULL,
    auto_approve     BOOLEAN NOT NULL DEFAULT false,
    default_group_id UUID NULL REFERENCES agent_groups(id) ON DELETE SET NULL,
    bound_agent_id   UUID NULL REFERENCES agents(id) ON DELETE SET NULL,
    created_by       TEXT NULL,
    note             TEXT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at       TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_enrollment_invites_created_at
    ON agent_enrollment_invites (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_enrollment_invites_expires_at
    ON agent_enrollment_invites (expires_at);

CREATE TABLE IF NOT EXISTS agent_enrollment_claims (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invite_id           UUID NULL REFERENCES agent_enrollment_invites(id) ON DELETE SET NULL,
    status              TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    requested_name      TEXT NOT NULL,
    hostname            TEXT NULL,
    os                  TEXT NULL,
    agent_version       TEXT NULL,
    install_id_digest   TEXT NULL,
    client_ip           TEXT NULL,
    discovered_server   TEXT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_by         TEXT NULL,
    approved_at         TIMESTAMPTZ NULL,
    rejected_by         TEXT NULL,
    rejected_at         TIMESTAMPTZ NULL,
    agent_id            UUID NULL REFERENCES agents(id) ON DELETE SET NULL,
    issued_token_hash   TEXT NULL,
    token_retrieved_at  TIMESTAMPTZ NULL,
    error               TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_enrollment_claims_status_created_at
    ON agent_enrollment_claims (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_enrollment_claims_invite_id
    ON agent_enrollment_claims (invite_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_enrollment_claims_active_install
    ON agent_enrollment_claims (install_id_digest)
    WHERE install_id_digest IS NOT NULL AND status = 'pending';
