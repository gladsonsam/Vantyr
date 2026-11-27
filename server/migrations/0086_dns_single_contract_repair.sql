-- Migration 0086: repair the DNS management desired version after 0085.
--
-- 0085 rewrote the canonical single-contract body/digest of formerly schema-1
-- rows WITHOUT changing their config_version. A worker that had already
-- applied version V under the old digest refuses the new digest at that SAME
-- version (equal-version / different-digest rejection). This migration advances
-- ONLY the desired config_version by one, so the already-converted canonical
-- body becomes a genuinely higher version that can be delivered and applied.
--
-- The body bytes and body_sha256 written by 0085 are left byte-for-byte intact:
-- they are the current contract and must not be recomputed here. Migrations
-- 0073..0085 and their checksums are untouched.
--
-- This migration does NOT advance delivered/reported pins and does NOT rewrite,
-- delete or fabricate any delivery, status, refresh or cache-clear ledger or
-- ack row, any policy/assignment/history row, or any audit evidence. The
-- repaired desired version honestly waits for worker delivery and application.
-- SQLx runs each migration in one transaction and the migration ledger gives
-- once-only execution; no runtime protocol marker or compatibility reader is
-- introduced. created_at, updated_at and updated_by are preserved: a migration
-- has no human actor, so writing one would be a fabricated attribution.

DO $$
DECLARE
    rec RECORD;
    -- BIGINT ceiling; the schema already guarantees config_version >= 1.
    MAX_VERSION CONSTANT BIGINT := 9223372036854775807;
BEGIN
    FOR rec IN
        SELECT household_id, config_version
        FROM network_dns_management_config
        ORDER BY household_id
    LOOP
        -- Explicit checked overflow: fail the whole migration atomically
        -- instead of wrapping a BIGINT or advancing an unusable version.
        IF rec.config_version >= MAX_VERSION THEN
            RAISE EXCEPTION
                'DNS management config_version overflow for household %: %',
                rec.household_id, rec.config_version;
        END IF;

        -- Guard the exact version that was read so a concurrent change cannot
        -- be silently overwritten; any drift aborts the transaction.
        UPDATE network_dns_management_config
        SET config_version = rec.config_version + 1
        WHERE household_id = rec.household_id
          AND config_version = rec.config_version;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'DNS management desired version changed during repair for household %',
                rec.household_id;
        END IF;
    END LOOP;
END $$;
