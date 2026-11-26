-- Migration 0074: correct the Vantyr Network inventory model.
--
-- 0073 is immutable. This correction makes devices household-owned instead of
-- global, removes the cross-household canonical-key oracle, lets connections
-- carry a device directly (no mandatory person/assignment), and adds a
-- household-scoped audit table so sensitive ids/keys never reach the globally
-- readable platform `audit_log`.
--
-- Existing rows are preserved. Backfill prefers an assignment's household;
-- a legacy device with no assignment is attached to the sole default household
-- when one exists. Any device that was assigned in several households is cloned
-- per extra household and those references are repointed, so no data is dropped.
-- A still-unscoped legacy device stays invisible to every scoped query rather
-- than being deleted.

-- ─── Household / person model fields ────────────────────────────────────────

ALTER TABLE network_households
    ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

ALTER TABLE network_persons
    ADD COLUMN IF NOT EXISTS is_default_profile BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS network_persons_one_default_profile
    ON network_persons (household_id) WHERE is_default_profile;

-- ─── Devices become household-owned ────────────────────────────────────────

ALTER TABLE network_devices
    ADD COLUMN IF NOT EXISTS household_id UUID NULL REFERENCES network_households(id) ON DELETE CASCADE;
ALTER TABLE network_devices
    ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT false;

UPDATE network_devices d
SET household_id = sub.household_id
FROM (
    SELECT device_id, MIN(household_id::text)::uuid AS household_id
    FROM network_assignments
    GROUP BY device_id
) sub
WHERE d.id = sub.device_id AND d.household_id IS NULL;

UPDATE network_devices d
SET household_id = h.id
FROM network_households h
WHERE d.household_id IS NULL
  AND h.is_default
  AND (SELECT COUNT(*) FROM network_households WHERE is_default) = 1;

-- Repoint assignments made in a household other than the backfilled device's
-- household to a per-household clone, preserving the assignment and its scope.
DO $$
DECLARE
    pair RECORD;
    clone_id UUID;
BEGIN
    FOR pair IN
        SELECT DISTINCT a.household_id, a.device_id
        FROM network_assignments a
        JOIN network_devices d ON d.id = a.device_id
        WHERE d.household_id IS DISTINCT FROM a.household_id
    LOOP
        clone_id := gen_random_uuid();
        INSERT INTO network_devices
            (id, household_id, canonical_key, label, device_type, shared, created_at, updated_at)
        SELECT clone_id, pair.household_id,
               d.canonical_key || '-legacy' || replace(left(clone_id::text, 8), '-', ''),
               d.label, d.device_type, d.shared, d.created_at, d.updated_at
        FROM network_devices d
        WHERE d.id = pair.device_id;

        UPDATE network_assignments
        SET device_id = clone_id
        WHERE device_id = pair.device_id AND household_id = pair.household_id;
    END LOOP;
END $$;

-- A canonical key is unique inside one household only: no global claim/oracle.
ALTER TABLE network_devices DROP CONSTRAINT IF EXISTS network_devices_canonical_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS network_devices_household_canonical_key
    ON network_devices (household_id, canonical_key);
CREATE UNIQUE INDEX IF NOT EXISTS network_devices_id_household
    ON network_devices (id, household_id);

ALTER TABLE network_assignments
    ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE network_assignments
    ADD CONSTRAINT network_assignments_device_household_fk
    FOREIGN KEY (device_id, household_id) REFERENCES network_devices(id, household_id) ON DELETE CASCADE;

-- ─── Connections carry the device directly ─────────────────────────────────

ALTER TABLE network_connections ADD COLUMN IF NOT EXISTS device_id UUID NULL;
UPDATE network_connections c
SET device_id = a.device_id
FROM network_assignments a
WHERE a.id = c.assignment_id
  AND a.household_id = c.household_id
  AND c.device_id IS NULL;

-- Defensive fallback for any legacy row whose assignment is already gone.
UPDATE network_connections c
SET device_id = d.id
FROM network_devices d
WHERE c.device_id IS NULL
  AND d.household_id = c.household_id
  AND d.id = (SELECT MIN(id::text)::uuid FROM network_devices WHERE household_id = c.household_id);

ALTER TABLE network_connections ALTER COLUMN device_id SET NOT NULL;
ALTER TABLE network_connections
    ADD CONSTRAINT network_connections_device_household_fk
    FOREIGN KEY (device_id, household_id) REFERENCES network_devices(id, household_id) ON DELETE CASCADE;

-- Assignment and verified enrollment are optional: an agentless TV can own a
-- DNS connection with no person and no assignment.
ALTER TABLE network_connections ALTER COLUMN assignment_id DROP NOT NULL;
ALTER TABLE network_connections ADD COLUMN IF NOT EXISTS enrolled_agent_id UUID NULL;
ALTER TABLE network_connections
    ADD CONSTRAINT network_connections_enrolled_agent_household_fk
    FOREIGN KEY (enrolled_agent_id, household_id)
    REFERENCES network_household_agents(agent_id, household_id) ON DELETE NO ACTION;
ALTER TABLE network_connections ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NULL;
ALTER TABLE network_connections ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ NULL;

ALTER TABLE network_connections DROP CONSTRAINT IF EXISTS network_connections_status_check;
ALTER TABLE network_connections
    ADD CONSTRAINT network_connections_status_check
    CHECK (status IN ('unknown','active','inactive','stale','error','revoked'));

COMMENT ON COLUMN network_connections.status IS
    'Reported/unverified observation recorded by a caller; never an enforcement flag.';
COMMENT ON COLUMN network_connections.capabilities IS
    'Reported/unverified capability strings; no runtime component acts on them.';
COMMENT ON COLUMN network_connections.provenance IS
    'Reported source label (manual/agent/dns/proxy/import); unverified in this slice.';

-- ─── Household-scoped audit ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS network_audit (
    id           BIGSERIAL   PRIMARY KEY,
    ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    household_id UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    actor        TEXT        NOT NULL,
    client_ip    TEXT        NULL,
    action       TEXT        NOT NULL,
    status       TEXT        NOT NULL DEFAULT 'ok',
    detail       JSONB       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_network_audit_household_ts
    ON network_audit (household_id, ts DESC);

-- Remove only this feature's legacy rows from the globally readable audit log;
-- unrelated audit history is untouched.
DELETE FROM audit_log WHERE action IN (
    'network_bootstrap', 'network_household_create',
    'network_person_create', 'network_person_update',
    'network_device_create', 'network_device_update',
    'network_assignment_create', 'network_assignment_update',
    'network_connection_create', 'network_connection_update',
    'network_agent_enroll', 'network_grant_set', 'network_grant_revoke'
);
