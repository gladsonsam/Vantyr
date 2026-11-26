-- Migration 0079: bounded mutable DNS management config, per-gateway delivery
-- evidence, per-gateway refresh request/ack state and a single latest status row.
--
-- Additive and latest: 0073..0078 and their checksums are untouched. Nothing
-- here writes network_policies, network_gateway_desired_policy, heartbeat
-- reports or BYOD state. A management config is a SAVED DESIRE with its own
-- monotonic config_version and CAS; it is NOT a policy revision, NOT applied
-- and NOT verified. The worker consumer is a separate subsequent stage.
--
-- Delivery evidence is a BOUNDED ledger of version+digest only (no config
-- bytes). The current delivered version and the latest reported-applied
-- version are pinned so lagging applied reports can be validated against a
-- genuinely delivered version+digest. Refresh acks are per gateway and bound
-- to (config_version, refresh_seq) so one gateway cannot hide a token from
-- another and a removed/re-added source id cannot consume a stale token.

-- ─── Mutable desired configuration (one row per household) ───────────────────

CREATE TABLE IF NOT EXISTS network_dns_management_config (
    household_id   UUID        PRIMARY KEY REFERENCES network_households(id) ON DELETE CASCADE,
    schema_version INTEGER     NOT NULL CHECK (schema_version = 1),
    config_version BIGINT      NOT NULL CHECK (config_version >= 1),
    -- Canonical serde bytes, exactly as hashed. No secrets and no URLs in logs.
    body           BYTEA       NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 16384),
    body_sha256    TEXT        NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by     UUID        NULL REFERENCES dashboard_users(id) ON DELETE SET NULL
);

COMMENT ON TABLE network_dns_management_config IS
    'Mutable desired DNS list/service settings. Independent monotonic config_version with CAS; never applied or verified.';
COMMENT ON COLUMN network_dns_management_config.body_sha256 IS
    'SHA-256 of the exact canonical stored bytes. Content digest, not a signature or enforcement claim.';

-- ─── Bounded per-gateway delivery ledger (version + digest only) ─────────────

CREATE TABLE IF NOT EXISTS network_dns_delivery (
    household_id   UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    gateway_id     UUID        NOT NULL,
    kind           TEXT        NOT NULL CHECK (kind = 'dns'),
    config_version BIGINT      NOT NULL CHECK (config_version >= 1),
    body_sha256    TEXT        NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
    delivered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (household_id, gateway_id, config_version),
    FOREIGN KEY (gateway_id, household_id, kind)
        REFERENCES network_gateways(id, household_id, kind) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_network_dns_delivery_recent
    ON network_dns_delivery (household_id, gateway_id, config_version DESC);

COMMENT ON TABLE network_dns_delivery IS
    'Bounded (latest 16 + fixed pins) evidence of config versions actually delivered to one DNS gateway. No config bytes.';

-- Fixed per-gateway pointers: at most one current delivery and one reported
-- applied version. These are pins for ledger retention, not enforcement flags.
CREATE TABLE IF NOT EXISTS network_dns_gateway_state (
    household_id      UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    gateway_id        UUID        NOT NULL,
    kind              TEXT        NOT NULL CHECK (kind = 'dns'),
    delivered_version BIGINT      NOT NULL CHECK (delivered_version >= 1),
    delivered_sha256  TEXT        NOT NULL CHECK (delivered_sha256 ~ '^[0-9a-f]{64}$'),
    reported_version  BIGINT      NULL CHECK (reported_version IS NULL OR reported_version >= 1),
    reported_sha256   TEXT        NULL CHECK (reported_sha256 IS NULL OR reported_sha256 ~ '^[0-9a-f]{64}$'),
    reported_at       TIMESTAMPTZ NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (household_id, gateway_id),
    CONSTRAINT network_dns_gateway_state_report_pinned CHECK (
        (reported_version IS NULL AND reported_sha256 IS NULL AND reported_at IS NULL)
        OR (reported_version IS NOT NULL AND reported_sha256 IS NOT NULL AND reported_at IS NOT NULL)
    ),
    FOREIGN KEY (gateway_id, household_id, kind)
        REFERENCES network_gateways(id, household_id, kind) ON DELETE CASCADE
);

-- ─── Manual refresh: one pending request per source, bounded per household ───

CREATE TABLE IF NOT EXISTS network_dns_refresh_request (
    household_id   UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    source_id      TEXT        NOT NULL CHECK (
        source_id ~ '^[A-Za-z0-9_-]{1,64}$'
    ),
    refresh_seq    BIGINT      NOT NULL CHECK (refresh_seq >= 1),
    config_version BIGINT      NOT NULL CHECK (config_version >= 1),
    requested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at     TIMESTAMPTZ NOT NULL,
    requested_by   UUID        NULL REFERENCES dashboard_users(id) ON DELETE SET NULL,
    PRIMARY KEY (household_id, source_id),
    CONSTRAINT network_dns_refresh_expiry CHECK (expires_at > requested_at)
);

CREATE OR REPLACE FUNCTION network_dns_refresh_request_cap() RETURNS trigger AS $$
DECLARE
    n INTEGER;
BEGIN
    SELECT COUNT(*) INTO n
      FROM network_dns_refresh_request
     WHERE household_id = NEW.household_id;
    IF n > 32 THEN
        RAISE EXCEPTION 'manual refresh request bound exceeded';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER network_dns_refresh_request_bounded
    BEFORE INSERT OR UPDATE ON network_dns_refresh_request
    FOR EACH ROW EXECUTE FUNCTION network_dns_refresh_request_cap();

COMMENT ON TABLE network_dns_refresh_request IS
    'At most 32 pending manual refresh tokens per household; one per source id, sequenced and bound to a config version.';

-- A token is delivered to a gateway only inside the gateway-scoped manager
-- read, and only when the config_version was also delivered to that gateway.
CREATE TABLE IF NOT EXISTS network_dns_refresh_delivery (
    household_id   UUID        NOT NULL,
    gateway_id     UUID        NOT NULL,
    source_id      TEXT        NOT NULL,
    refresh_seq    BIGINT      NOT NULL CHECK (refresh_seq >= 1),
    config_version BIGINT      NOT NULL CHECK (config_version >= 1),
    delivered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (household_id, gateway_id, source_id),
    FOREIGN KEY (household_id, source_id)
        REFERENCES network_dns_refresh_request(household_id, source_id) ON DELETE CASCADE,
    FOREIGN KEY (household_id, gateway_id, config_version)
        REFERENCES network_dns_delivery(household_id, gateway_id, config_version) ON DELETE CASCADE
);

-- Per-gateway ack: exact (seq, config_version) replay is idempotent; a
-- different token cannot overwrite an accepted ack for the same source.
CREATE TABLE IF NOT EXISTS network_dns_refresh_ack (
    household_id   UUID        NOT NULL,
    gateway_id     UUID        NOT NULL,
    source_id      TEXT        NOT NULL,
    refresh_seq    BIGINT      NOT NULL CHECK (refresh_seq >= 1),
    config_version BIGINT      NOT NULL CHECK (config_version >= 1),
    acked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (household_id, gateway_id, source_id),
    FOREIGN KEY (household_id, gateway_id, source_id)
        REFERENCES network_dns_refresh_delivery(household_id, gateway_id, source_id) ON DELETE CASCADE
);

-- ─── Latest bounded status per gateway (upsert, no unbounded history) ─────────

CREATE TABLE IF NOT EXISTS network_dns_status (
    household_id      UUID        NOT NULL,
    gateway_id        UUID        NOT NULL,
    credential_id     UUID        NOT NULL,
    -- Worker-generated idempotency id for one report.
    report_id         UUID        NOT NULL,
    config_version    BIGINT      NOT NULL CHECK (config_version >= 1),
    body_sha256       TEXT        NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
    reported_at       TIMESTAMPTZ NOT NULL,
    received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- NULL is truthful: delivered but never applied (e.g. failed download).
    applied_version   BIGINT      NULL CHECK (applied_version IS NULL OR applied_version >= 1),
    applied_at        TIMESTAMPTZ NULL,
    applied_error     TEXT        NULL CHECK (applied_error IS NULL OR length(applied_error) <= 200),
    generation        BIGINT      NULL CHECK (generation IS NULL OR generation >= 0),
    filter_generation BIGINT      NULL CHECK (filter_generation IS NULL OR filter_generation >= 0),
    filter_identity   TEXT        NULL CHECK (filter_identity IS NULL OR length(filter_identity) <= 64),
    -- Fixed 32-element array of sanitized source observations. No URLs,
    -- no raw ETag, no secret material.
    sources           JSONB       NOT NULL CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) <= 32),
    CONSTRAINT network_dns_status_applied_pinned CHECK (
        (applied_version IS NULL AND generation IS NULL AND filter_generation IS NULL AND filter_identity IS NULL)
        OR (applied_version IS NOT NULL AND generation IS NOT NULL
            AND filter_generation IS NOT NULL AND filter_identity IS NOT NULL)
    ),
    PRIMARY KEY (household_id, gateway_id),
    FOREIGN KEY (household_id, gateway_id, config_version)
        REFERENCES network_dns_delivery(household_id, gateway_id, config_version) ON DELETE RESTRICT,
    FOREIGN KEY (credential_id, household_id, gateway_id)
        REFERENCES network_gateway_credentials(id, household_id, gateway_id) ON DELETE CASCADE
);

COMMENT ON TABLE network_dns_status IS
    'One latest worker-reported DNS status per gateway. Downloaded vs locally applied only: no verified/enforced flag exists.';

-- ─── Explicit opt-in worker command scope (no row is updated) ────────────────

ALTER TABLE network_gateway_credentials
    DROP CONSTRAINT IF EXISTS network_gateway_commands_bounded;
ALTER TABLE network_gateway_credentials
    ADD CONSTRAINT network_gateway_commands_bounded CHECK (
        cardinality(allowed_commands) BETWEEN 1 AND 8
        AND allowed_commands <@ ARRAY[
            'heartbeat', 'read_policy', 'read_dns_management', 'report_dns_status'
        ]::text[]
    );

COMMENT ON COLUMN network_gateway_credentials.allowed_commands IS
    'Explicit command allowlist. Default issuance stays heartbeat-only; new commands are never added to existing rows.';
