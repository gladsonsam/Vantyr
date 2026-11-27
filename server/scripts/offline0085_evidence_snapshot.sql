-- offline0085_evidence_snapshot.sql
--
-- EXPLICIT OPERATOR SCRIPT. This is NOT an automatic migration, NOT a runtime
-- reader and NOT a code path in the server or worker. It adds no Rust, changes
-- no migration file, version, description or checksum, and touches no host or
-- production database by itself. An operator runs it by hand against a
-- disposable / operator-controlled PostgreSQL database.
--
-- WHY: migration 0085 (committed in this tree) rewrites the body digest of every
-- schema-1 network_dns_management_config row at the SAME config_version, and
-- rewrites the matching digest pins in network_dns_delivery, network_dns_status
-- and network_dns_gateway_state (both delivered and reported). Once that runs,
-- the pre-migration digests are gone from the database unless they are saved
-- first. This script saves them, plus the exact desired-config metadata, so
-- offline0085_evidence_restore.sql can put the evidence back after 0085 and 0086.
--
-- HARD OPERATING RULE: stop every controller, API and worker write BEFORE this
-- script runs. Writes stay STOPPED from preflight through 0085/0086 migration
-- and until the restore has been verified. See README.offline0085.md.
--
-- RERUN POLICY: rerunnable only while 0085 is NOT in the ledger; a prior
-- snapshot is replaced. Refuses to run once 0085 exists, so a good backup is
-- never clobbered. An overflow failure leaves any earlier snapshot intact.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    -- Byte-exact text appended by migration 0085: same literal, same field order.
    -- Never parse through jsonb (that would reorder keys and break the digest).
    default_runtime constant text := ',"runtime":{"cache":{"enabled":true,"max_entries":4096,"positive_min_ttl_secs":null,"positive_max_ttl_secs":null,"negative_min_ttl_secs":null,"negative_max_ttl_secs":null},"deny":{"mode":"nxdomain"}}}';
    -- 0085 drops the final '}' then appends default_runtime. The exact byte
    -- delta is derived from the literal above (200 - 1 = 199), not hardcoded.
    appended_bytes constant integer := length(default_runtime) - 1;
    -- From the network_dns_management_config body CHECK constraint.
    body_limit     constant integer := 16384;
    rec record;
BEGIN
    -- Preflight: 0085 must not be applied (successful or dirty).
    IF EXISTS (SELECT 1 FROM _sqlx_migrations WHERE version = 85) THEN
        RAISE EXCEPTION 'offline0085 snapshot refused: migration 0085 is already in the ledger; refusing to clobber an existing backup';
    END IF;

    -- Validate EVERY candidate before creating or writing the staging table.
    -- An overflow raises here, before any durable snapshot is produced, and
    -- the surrounding transaction rolls back any partial work.
    FOR rec IN
        SELECT household_id, body
        FROM network_dns_management_config
        WHERE schema_version = 1
    LOOP
        IF right(convert_from(rec.body, 'UTF8'), 1) <> '}' THEN
            RAISE EXCEPTION 'offline0085 snapshot refused: non-canonical schema-1 body for household %', rec.household_id;
        END IF;
        IF octet_length(rec.body) + appended_bytes > body_limit THEN
            RAISE EXCEPTION 'offline0085 snapshot refused: converted body would exceed % bytes for household %; shrink through the old app, then restart the procedure', body_limit, rec.household_id;
        END IF;
    END LOOP;

    -- Clearly named operator staging table. Kept on purpose for recovery after
    -- the restore; the restore script never drops or truncates it.
    CREATE TABLE IF NOT EXISTS operator_offline0085_dns_evidence_snapshot (
        household_id            UUID        NOT NULL,
        gateway_id              UUID        NULL,   -- NULL only for desired_config
        kind                    TEXT        NOT NULL CHECK (kind IN (
            'desired_config', 'delivery', 'status',
            'gateway_delivered', 'gateway_reported')),
        config_version          BIGINT      NOT NULL CHECK (config_version >= 1),
        original_digest         TEXT        NOT NULL CHECK (original_digest ~ '^[0-9a-f]{64}$'),
        converted_digest        TEXT        NOT NULL CHECK (converted_digest ~ '^[0-9a-f]{64}$'),
        original_schema_version INTEGER     NULL,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT offline0085_snapshot_shape CHECK (
            (kind = 'desired_config' AND gateway_id IS NULL
                AND original_schema_version = 1)
            OR (kind <> 'desired_config' AND gateway_id IS NOT NULL
                AND original_schema_version IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS offline0085_snapshot_desired_unique
        ON operator_offline0085_dns_evidence_snapshot (household_id)
        WHERE kind = 'desired_config';
    CREATE UNIQUE INDEX IF NOT EXISTS offline0085_snapshot_evidence_unique
        ON operator_offline0085_dns_evidence_snapshot
        (household_id, gateway_id, config_version, kind)
        WHERE kind <> 'desired_config';

    -- Idempotent only while pre-0085 (guarded above).
    DELETE FROM operator_offline0085_dns_evidence_snapshot;

    FOR rec IN
        SELECT household_id, config_version, body, body_sha256
        FROM network_dns_management_config
        WHERE schema_version = 1
    LOOP
        DECLARE
            old_body   text;
            new_body   text;
            new_digest text;
        BEGIN
            old_body   := convert_from(rec.body, 'UTF8');
            new_body   := left(old_body, length(old_body) - 1) || default_runtime;
            new_digest := encode(sha256(convert_to(new_body, 'UTF8')), 'hex');

            -- Original desired version + digest, and the exact digest 0085 will
            -- produce. Sufficient to guard that restore lands on the expected
            -- post-0085/0086 state (desired version V+1, converted body/digest).
            INSERT INTO operator_offline0085_dns_evidence_snapshot
                (household_id, gateway_id, kind, config_version,
                 original_digest, converted_digest, original_schema_version)
            VALUES
                (rec.household_id, NULL, 'desired_config', rec.config_version,
                 rec.body_sha256, new_digest, 1);

            -- Same predicates as migration 0085, scoped by household/gateway/
            -- version/kind. Only rows 0085 will actually rewrite are saved.
            INSERT INTO operator_offline0085_dns_evidence_snapshot
                (household_id, gateway_id, kind, config_version,
                 original_digest, converted_digest)
            SELECT d.household_id, d.gateway_id, 'delivery', d.config_version,
                   d.body_sha256, new_digest
            FROM network_dns_delivery d
            WHERE d.household_id = rec.household_id
              AND d.config_version = rec.config_version
              AND d.body_sha256 = rec.body_sha256;

            INSERT INTO operator_offline0085_dns_evidence_snapshot
                (household_id, gateway_id, kind, config_version,
                 original_digest, converted_digest)
            SELECT s.household_id, s.gateway_id, 'status', s.config_version,
                   s.body_sha256, new_digest
            FROM network_dns_status s
            WHERE s.household_id = rec.household_id
              AND s.config_version = rec.config_version
              AND s.body_sha256 = rec.body_sha256;

            INSERT INTO operator_offline0085_dns_evidence_snapshot
                (household_id, gateway_id, kind, config_version,
                 original_digest, converted_digest)
            SELECT g.household_id, g.gateway_id, 'gateway_delivered',
                   g.delivered_version, g.delivered_sha256, new_digest
            FROM network_dns_gateway_state g
            WHERE g.household_id = rec.household_id
              AND g.delivered_version = rec.config_version
              AND g.delivered_sha256 = rec.body_sha256;

            INSERT INTO operator_offline0085_dns_evidence_snapshot
                (household_id, gateway_id, kind, config_version,
                 original_digest, converted_digest)
            SELECT g.household_id, g.gateway_id, 'gateway_reported',
                   g.reported_version, g.reported_sha256, new_digest
            FROM network_dns_gateway_state g
            WHERE g.household_id = rec.household_id
              AND g.reported_version = rec.config_version
              AND g.reported_sha256 = rec.body_sha256;
        END;
    END LOOP;
END
$$;

COMMIT;
