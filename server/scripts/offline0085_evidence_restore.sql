-- offline0085_evidence_restore.sql
--
-- EXPLICIT OPERATOR SCRIPT. Not an automatic migration, not a runtime reader,
-- not a code path in the server or worker. It never inserts evidence, never
-- fabricates a pin/status row and never changes a version or creates a ledger
-- row. Run by hand, with psql, on the same operator-controlled database after
-- migrations 0085 and 0086 have both been applied.
--
-- WHAT IT RESTORES: the exact pre-0085 digest values captured by
-- offline0085_evidence_snapshot.sql, only on evidence rows that still exist at
-- the exact snapshotted (household, gateway, version, kind) key and whose
-- current digest is still the 0085-converted value. A missing row or a changed
-- digest aborts the whole transaction; there is no partial silent repair.
--
-- HARD OPERATING RULE: controllers, API and worker writes stay STOPPED from
-- preflight through migration and until this restore is verified. See
-- README.offline0085.md. The snapshot table is deliberately KEPT afterwards.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    rec           record;
    cur           record;
    current_digest text;
    expected_rows bigint;
BEGIN
    -- Preflight: both migrations applied, and a real snapshot exists.
    IF NOT EXISTS (SELECT 1 FROM _sqlx_migrations WHERE version = 85 AND success) THEN
        RAISE EXCEPTION 'offline0085 restore refused: migration 0085 is not applied';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM _sqlx_migrations WHERE version = 86 AND success) THEN
        RAISE EXCEPTION 'offline0085 restore refused: migration 0086 is not applied';
    END IF;
    IF to_regclass('operator_offline0085_dns_evidence_snapshot') IS NULL THEN
        RAISE EXCEPTION 'offline0085 restore refused: no snapshot table; originals cannot be reconstructed';
    END IF;
    IF to_regclass('operator_offline0085_dns_snapshot_metadata') IS NULL THEN
        RAISE EXCEPTION 'offline0085 restore refused: no completed snapshot marker';
    END IF;
    SELECT captured_rows INTO expected_rows
    FROM operator_offline0085_dns_snapshot_metadata WHERE singleton;
    IF NOT FOUND OR expected_rows <> (SELECT count(*) FROM operator_offline0085_dns_evidence_snapshot) THEN
        RAISE EXCEPTION 'offline0085 restore refused: snapshot is incomplete or was changed';
    END IF;
    IF expected_rows = 0 THEN
        RETURN; -- Completed preflight found no schema-1 evidence to restore.
    END IF;

    -- Guard the desired config: after 0085 + 0086 it must be exactly the
    -- snapshotted version V bumped once (V+1) with the snapshotted converted
    -- body/digest. Lock it so a stray writer cannot slip between guard and
    -- restore. No digest values are printed in these messages.
    FOR rec IN
        SELECT * FROM operator_offline0085_dns_evidence_snapshot
        WHERE kind = 'desired_config'
    LOOP
        SELECT config_version, body_sha256, body
        INTO cur
        FROM network_dns_management_config
        WHERE household_id = rec.household_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'offline0085 restore refused: snapshotted desired config row is missing';
        END IF;
        IF cur.config_version <> rec.config_version + 1 THEN
            RAISE EXCEPTION 'offline0085 restore refused: desired version is not the expected V+1 for a snapshotted household';
        END IF;
        IF cur.body_sha256 <> rec.converted_digest THEN
            RAISE EXCEPTION 'offline0085 restore refused: desired digest is not the snapshotted converted digest';
        END IF;
        IF encode(sha256(cur.body), 'hex') <> rec.converted_digest THEN
            RAISE EXCEPTION 'offline0085 restore refused: desired body is not the snapshotted converted body';
        END IF;
    END LOOP;

    -- Guard and restore each exact scoped evidence row. FOR UPDATE serialises
    -- against stray writes; any exception aborts and rolls back every update.
    FOR rec IN
        SELECT * FROM operator_offline0085_dns_evidence_snapshot
        WHERE kind <> 'desired_config'
    LOOP
        current_digest := NULL;

        CASE rec.kind
            WHEN 'delivery' THEN
                SELECT body_sha256 INTO current_digest
                FROM network_dns_delivery
                WHERE household_id = rec.household_id
                  AND gateway_id = rec.gateway_id
                  AND config_version = rec.config_version
                FOR UPDATE;
            WHEN 'status' THEN
                SELECT body_sha256 INTO current_digest
                FROM network_dns_status
                WHERE household_id = rec.household_id
                  AND gateway_id = rec.gateway_id
                  AND config_version = rec.config_version
                FOR UPDATE;
            WHEN 'gateway_delivered' THEN
                SELECT delivered_sha256 INTO current_digest
                FROM network_dns_gateway_state
                WHERE household_id = rec.household_id
                  AND gateway_id = rec.gateway_id
                  AND delivered_version = rec.config_version
                FOR UPDATE;
            WHEN 'gateway_reported' THEN
                SELECT reported_sha256 INTO current_digest
                FROM network_dns_gateway_state
                WHERE household_id = rec.household_id
                  AND gateway_id = rec.gateway_id
                  AND reported_version = rec.config_version
                FOR UPDATE;
        END CASE;

        IF current_digest IS NULL THEN
            RAISE EXCEPTION 'offline0085 restore refused: snapshotted % evidence row is missing', rec.kind;
        END IF;
        IF current_digest <> rec.converted_digest THEN
            RAISE EXCEPTION 'offline0085 restore refused: snapshotted % evidence row changed unexpectedly', rec.kind;
        END IF;

        CASE rec.kind
            WHEN 'delivery' THEN
                UPDATE network_dns_delivery
                SET body_sha256 = rec.original_digest
                WHERE household_id = rec.household_id
                  AND gateway_id = rec.gateway_id
                  AND config_version = rec.config_version
                  AND body_sha256 = rec.converted_digest;
            WHEN 'status' THEN
                UPDATE network_dns_status
                SET body_sha256 = rec.original_digest
                WHERE household_id = rec.household_id
                  AND gateway_id = rec.gateway_id
                  AND config_version = rec.config_version
                  AND body_sha256 = rec.converted_digest;
            WHEN 'gateway_delivered' THEN
                UPDATE network_dns_gateway_state
                SET delivered_sha256 = rec.original_digest
                WHERE household_id = rec.household_id
                  AND gateway_id = rec.gateway_id
                  AND delivered_version = rec.config_version
                  AND delivered_sha256 = rec.converted_digest;
            WHEN 'gateway_reported' THEN
                UPDATE network_dns_gateway_state
                SET reported_sha256 = rec.original_digest
                WHERE household_id = rec.household_id
                  AND gateway_id = rec.gateway_id
                  AND reported_version = rec.config_version
                  AND reported_sha256 = rec.converted_digest;
        END CASE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'offline0085 restore refused: % evidence row changed during restore', rec.kind;
        END IF;
    END LOOP;
END
$$;

-- The snapshot table is intentionally NOT dropped or truncated: keep it for
-- recovery. Verify the restore before restarting any writer.
COMMIT;
