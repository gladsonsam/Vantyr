-- Migration 0078: authenticated BYOD enrollment foundation.
--
-- Additive and latest: 0073..0077 stay immutable; no earlier checksum is
-- changed. Nothing here touches agent api tokens, module grants, Recall,
-- worker credentials, PKI/CA tables, router/DHCP state or the global audit log.
--
-- The only authorization inputs are an explicit `network_enroll` grant and an
-- admin-created principal binding between a REAL dashboard user and an existing
-- network person in the same household. No IP, MAC, canonical device key,
-- hostname or self-asserted body profile is treated as an identity claim.
--
-- Secrets are 256-bit random values stored only as SHA-256 digests in a new
-- credential family. There is no plaintext listing, no secret in audit/error
-- text, and no relation to gateway or agent tokens.

-- ─── New explicit, independent grant ─────────────────────────────────────────

DO $$
DECLARE
    old_check text;
BEGIN
    -- 0073 declared the check inline, so its generated name can vary. Drop any
    -- check that constrains grant_name, then add the one authoritative check.
    FOR old_check IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'network_grants'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%grant_name%'
    LOOP
        EXECUTE format('ALTER TABLE network_grants DROP CONSTRAINT %I', old_check);
    END LOOP;
END $$;
ALTER TABLE network_grants
    ADD CONSTRAINT network_grants_grant_name_check
    CHECK (grant_name IN ('network_admin', 'network_events', 'network_enroll'));

-- No grant rows are inserted by this migration. An administrator must grant
-- `network_enroll` explicitly, exactly as for the other two network grants.

-- ─── Explicit principal binding (dashboard user <-> person) ──────────────────

CREATE TABLE IF NOT EXISTS network_principal_bindings (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id   UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    dashboard_user UUID        NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
    person_id      UUID        NOT NULL,
    -- Bumped on every revocation/re-mapping. Grants and sessions carry the
    -- generation they were issued under, so a bump invalidates all of them.
    generation     BIGINT      NOT NULL DEFAULT 1 CHECK (generation > 0),
    active         BOOLEAN     NOT NULL DEFAULT true,
    created_by     UUID        NULL REFERENCES dashboard_users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at     TIMESTAMPTZ NULL,
    -- Exactly one binding per household/user; re-mapping reuses the row and
    -- bumps the generation rather than creating a second active principal.
    UNIQUE (household_id, dashboard_user),
    UNIQUE (id, household_id, generation),
    UNIQUE (id, household_id),
    FOREIGN KEY (person_id, household_id)
        REFERENCES network_persons(id, household_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_principal_bindings_household
    ON network_principal_bindings (household_id, active, created_at DESC);

COMMENT ON COLUMN network_principal_bindings.dashboard_user IS
    'Existing dashboard user chosen by an explicit admin mapping; never inferred from a device, IP or body claim.';
COMMENT ON COLUMN network_principal_bindings.generation IS
    'Incremented on revoke/re-map; outstanding grants and sessions carry the generation they were issued under.';

-- ─── Device enrollment authorization ─────────────────────────────────────────

-- A device is either pre-authorized by a network_admin to an existing binding,
-- or registered by the authenticated user themselves with a server-generated
-- canonical key. A caller can never claim an arbitrary existing device UUID.
CREATE TABLE IF NOT EXISTS network_device_enrollments (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id   UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    binding_id     UUID        NOT NULL,
    device_id      UUID        NOT NULL,
    generation     BIGINT      NOT NULL CHECK (generation > 0),
    status         TEXT        NOT NULL DEFAULT 'authorized'
        CHECK (status IN ('authorized', 'active', 'ended')),
    -- NULL means the authenticated user self-registered the device.
    authorized_by  UUID        NULL REFERENCES dashboard_users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at       TIMESTAMPTZ NULL,
    UNIQUE (id, household_id),
    FOREIGN KEY (binding_id, household_id)
        REFERENCES network_principal_bindings(id, household_id) ON DELETE CASCADE,
    FOREIGN KEY (device_id, household_id)
        REFERENCES network_devices(id, household_id) ON DELETE CASCADE
);
-- Conservative: one live enrollment per device in a household.
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_enrollment_live
    ON network_device_enrollments (household_id, device_id)
    WHERE status IN ('authorized', 'active');
CREATE INDEX IF NOT EXISTS idx_device_enrollments_binding
    ON network_device_enrollments (household_id, binding_id, created_at DESC);

COMMENT ON COLUMN network_device_enrollments.authorized_by IS
    'Admin who pre-authorized an existing device; NULL for a user self-registered BYOD device.';

-- ─── Single-use enrollment grants ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS network_enrollment_grants (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id         UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    binding_id           UUID        NOT NULL,
    device_enrollment_id UUID        NOT NULL,
    device_id            UUID        NOT NULL,
    dashboard_user       UUID        NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
    person_id            UUID        NOT NULL,
    generation           BIGINT      NOT NULL CHECK (generation > 0),
    -- Minimal initial purpose allowlist. `dns_setup` is reserved for a later
    -- bounded slice; accepting it here only issues a scoped grant receipt.
    purpose              TEXT        NOT NULL CHECK (purpose IN ('proxy_setup', 'dns_setup')),
    verification_method  TEXT        NOT NULL DEFAULT 'oidc_session'
        CHECK (verification_method = 'oidc_session'),
    secret_hash          TEXT        NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
    expires_at           TIMESTAMPTZ NOT NULL,
    consumed_at          TIMESTAMPTZ NULL,
    revoked_at           TIMESTAMPTZ NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT network_enrollment_grants_expiry CHECK (expires_at > created_at),
    UNIQUE (id, household_id),
    UNIQUE (secret_hash),
    -- Generation is checked by the locked consume path, not by this FK: a
    -- generation bump must be possible while historical grant rows remain.
    FOREIGN KEY (binding_id, household_id)
        REFERENCES network_principal_bindings(id, household_id) ON DELETE CASCADE,
    FOREIGN KEY (device_enrollment_id, household_id)
        REFERENCES network_device_enrollments(id, household_id) ON DELETE CASCADE,
    FOREIGN KEY (device_id, household_id)
        REFERENCES network_devices(id, household_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_enrollment_grants_scope
    ON network_enrollment_grants (household_id, binding_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrollment_grants_device
    ON network_enrollment_grants (household_id, device_id, consumed_at);

COMMENT ON COLUMN network_enrollment_grants.secret_hash IS
    'SHA-256 digest of a 256-bit random secret. Plaintext is returned once and never stored.';
COMMENT ON COLUMN network_enrollment_grants.verification_method IS
    'OIDC session-cookie authentication at issuance. Not proof of DNS/proxy coverage or of the current device owner.';

-- ─── Verified, time-bounded sessions ─────────────────────────────────────────

-- A session records that an authenticated person used a specific authorized
-- device for a specific purpose. It does NOT claim that DNS or proxy traffic is
-- actually routed/protected; no runtime identity integration exists yet.
CREATE TABLE IF NOT EXISTS network_verified_sessions (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id        UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    binding_id          UUID        NOT NULL,
    device_id           UUID        NOT NULL,
    dashboard_user      UUID        NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
    person_id           UUID        NOT NULL,
    generation          BIGINT      NOT NULL CHECK (generation > 0),
    purpose             TEXT        NOT NULL CHECK (purpose IN ('proxy_setup', 'dns_setup')),
    verification_method TEXT        NOT NULL CHECK (verification_method = 'oidc_session'),
    verified_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    ended_at            TIMESTAMPTZ NULL,
    end_reason          TEXT        NULL CHECK (end_reason IN (
        'self', 'self_all', 'binding_revoked', 'device_ended',
        'generation_changed', 'expired', 'superseded'
    )),
    CONSTRAINT network_verified_sessions_expiry CHECK (expires_at > verified_at),
    UNIQUE (id, household_id),
    FOREIGN KEY (binding_id, household_id)
        REFERENCES network_principal_bindings(id, household_id) ON DELETE CASCADE,
    FOREIGN KEY (device_id, household_id)
        REFERENCES network_devices(id, household_id) ON DELETE CASCADE
);
-- Conservative concurrent-device policy: one active session per device. A new
-- person must end the previous session first; no owner inference is made.
CREATE UNIQUE INDEX IF NOT EXISTS uq_verified_session_live_device
    ON network_verified_sessions (household_id, device_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_verified_sessions_scope
    ON network_verified_sessions (household_id, binding_id, verified_at DESC);

COMMENT ON COLUMN network_verified_sessions.verification_method IS
    'Reused OIDC/session-cookie evidence from the grant. Not a runtime DNS/proxy identity or coverage proof.';

-- ─── Bounded, non-free-text attempt history ──────────────────────────────────

-- Outcome codes only: no arbitrary text, no secret, no person/device claims.
CREATE TABLE IF NOT EXISTS network_enrollment_attempts (
    id           BIGSERIAL   PRIMARY KEY,
    household_id UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    binding_id   UUID        NULL,
    grant_id     UUID        NULL,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    outcome      TEXT        NOT NULL CHECK (outcome IN (
        'wrong_scope', 'wrong_device', 'wrong_purpose', 'wrong_secret',
        'expired', 'revoked', 'generation_mismatch', 'not_active',
        'session_conflict', 'not_found', 'bad_request'
    ))
);
CREATE INDEX IF NOT EXISTS idx_enrollment_attempts_scope
    ON network_enrollment_attempts (household_id, occurred_at DESC, id DESC);

COMMENT ON TABLE network_enrollment_attempts IS
    'Bounded outcome-code history (age + count, pruned on write). No free text or secret material.';
