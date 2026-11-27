-- Migration 0085: collapse the DNS management wire to ONE current contract.
--
-- Migrations 0073..0084 and their checksums are untouched, including event
-- 0081/0084 and the reserved proxy 0083. This migration does not delete or
-- rewrite auth, audit, person, household or policy records; it only upgrades
-- provisional DNS management desire and its own delivery/status evidence.
--
-- The single current ManagementConfig is the former v2 byte order with the
-- runtime object merged in: sources, catalog, selected_services, runtime.
-- `runtime` is REQUIRED in the typed DTO, so an old shape is rejected rather
-- than silently accepted. No applied migration checksum is rewritten.

DO $$
DECLARE
    rec RECORD;
    old_body text;
    new_body text;
    new_digest text;
    default_runtime text := ',"runtime":{"cache":{"enabled":true,"max_entries":4096,"positive_min_ttl_secs":null,"positive_max_ttl_secs":null,"negative_min_ttl_secs":null,"negative_max_ttl_secs":null},"deny":{"mode":"nxdomain"}}}';
BEGIN
    FOR rec IN
        SELECT household_id, config_version, body, body_sha256, schema_version
        FROM network_dns_management_config
    LOOP
        old_body := convert_from(rec.body, 'UTF8');
        IF rec.schema_version = 1 THEN
            -- Preserve the exact canonical bytes; append the current default
            -- runtime in serde field order. Never reparse through jsonb, which
            -- would reorder keys and break the worker-side digest check.
            IF right(old_body, 1) <> '}' THEN
                RAISE EXCEPTION 'stored DNS management body is not canonical';
            END IF;
            new_body := left(old_body, length(old_body) - 1) || default_runtime;
        ELSIF rec.schema_version = 2 THEN
            -- Already byte-identical to the single current shape.
            new_body := old_body;
        ELSE
            RAISE EXCEPTION 'unsupported stored DNS management schema %', rec.schema_version;
        END IF;
        new_digest := encode(sha256(convert_to(new_body, 'UTF8')), 'hex');

        UPDATE network_dns_management_config
        SET body = convert_to(new_body, 'UTF8'), body_sha256 = new_digest
        WHERE household_id = rec.household_id;

        -- Keep previously delivered/reported evidence coherent with the one
        -- current digest; config versions, timestamps and generations stay.
        UPDATE network_dns_delivery
        SET body_sha256 = new_digest
        WHERE household_id = rec.household_id
          AND config_version = rec.config_version
          AND body_sha256 = rec.body_sha256;
        UPDATE network_dns_gateway_state
        SET delivered_sha256 = new_digest
        WHERE household_id = rec.household_id
          AND delivered_version = rec.config_version
          AND delivered_sha256 = rec.body_sha256;
        UPDATE network_dns_gateway_state
        SET reported_sha256 = new_digest
        WHERE household_id = rec.household_id
          AND reported_version = rec.config_version
          AND reported_sha256 = rec.body_sha256;
        UPDATE network_dns_status
        SET body_sha256 = new_digest
        WHERE household_id = rec.household_id
          AND config_version = rec.config_version
          AND body_sha256 = rec.body_sha256;
    END LOOP;
END $$;

-- No protocol discriminator remains: strict typed parsing of the single
-- current config is the only gate.
ALTER TABLE network_dns_management_config DROP COLUMN IF EXISTS schema_version;
