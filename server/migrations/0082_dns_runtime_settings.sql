-- Migration 0082: additive v2 DNS management runtime settings + cache-clear commands.
--
-- Migrations 0073..0081 (including the reserved 0081) and their checksums are
-- untouched. No row is UPDATEd: existing heartbeat/read_policy credentials
-- gain no new command, and a default issuance stays heartbeat-only. The only
-- schema widening is the stored management config version, from 1 to {1,2}.
-- A cache clear targets the CURRENT resolver cache only: it never advances a
-- policy revision, publication time or bundle generation, and it never claims
-- an entry count or a flush barrier against in-flight repopulation.

ALTER TABLE network_dns_management_config
    DROP CONSTRAINT IF EXISTS network_dns_management_config_schema_version_check;
ALTER TABLE network_dns_management_config
    ADD CONSTRAINT network_dns_management_config_schema_version_check
    CHECK (schema_version IN (1, 2));

COMMENT ON COLUMN network_dns_management_config.schema_version IS
    '1 = frozen v1 list/service config; 2 = same base plus explicitly supported runtime cache/response settings.';

-- ─── Cache clear: one pending request per household ──────────────────────────

CREATE TABLE IF NOT EXISTS network_dns_cache_clear_request (
    household_id   UUID        PRIMARY KEY REFERENCES network_households(id) ON DELETE CASCADE,
    clear_seq      BIGINT      NOT NULL CHECK (clear_seq >= 1),
    config_version BIGINT      NOT NULL CHECK (config_version >= 1),
    requested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at     TIMESTAMPTZ NOT NULL,
    requested_by   UUID        NULL REFERENCES dashboard_users(id) ON DELETE SET NULL,
    CONSTRAINT network_dns_cache_clear_expiry CHECK (expires_at > requested_at)
);

COMMENT ON TABLE network_dns_cache_clear_request IS
    'At most one pending cache-clear command per household, sequenced and bound to the config version at request time.';

-- ─── Per-gateway delivery of the exact command ───────────────────────────────

CREATE TABLE IF NOT EXISTS network_dns_cache_clear_delivery (
    household_id   UUID        NOT NULL,
    gateway_id     UUID        NOT NULL,
    kind           TEXT        NOT NULL CHECK (kind = 'dns'),
    clear_seq      BIGINT      NOT NULL CHECK (clear_seq >= 1),
    config_version BIGINT      NOT NULL CHECK (config_version >= 1),
    requested_at   TIMESTAMPTZ NOT NULL,
    delivered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (household_id, gateway_id),
    FOREIGN KEY (household_id, gateway_id, config_version)
        REFERENCES network_dns_delivery(household_id, gateway_id, config_version) ON DELETE CASCADE,
    FOREIGN KEY (gateway_id, household_id, kind)
        REFERENCES network_gateways(id, household_id, kind) ON DELETE CASCADE
);

COMMENT ON TABLE network_dns_cache_clear_delivery IS
    'Gateway-scoped delivery evidence for one exact cache-clear token. A token is visible only inside that gateway''s manager read.';

-- ─── Per-gateway truthful attempt/ack ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS network_dns_cache_clear_ack (
    household_id   UUID        NOT NULL,
    gateway_id     UUID        NOT NULL,
    clear_seq      BIGINT      NOT NULL CHECK (clear_seq >= 1),
    config_version BIGINT      NOT NULL CHECK (config_version >= 1),
    attempted_at   TIMESTAMPTZ NOT NULL,
    acked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (household_id, gateway_id),
    FOREIGN KEY (household_id, gateway_id)
        REFERENCES network_dns_cache_clear_delivery(household_id, gateway_id) ON DELETE CASCADE
);

COMMENT ON TABLE network_dns_cache_clear_ack IS
    'One accepted ack per gateway: attempted_at is the worker clock at clear_cache(); acked_at is server receipt. No entries count.';
