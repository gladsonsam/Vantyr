-- Correct the BEFORE-row cap without changing the shipped 0079 checksum.
-- Locking the household also serializes direct inserts at the database boundary.
CREATE OR REPLACE FUNCTION network_dns_refresh_request_cap() RETURNS trigger AS $$
DECLARE
    n INTEGER;
BEGIN
    PERFORM id FROM network_households WHERE id = NEW.household_id FOR UPDATE;
    IF TG_OP = 'INSERT' OR NEW.household_id IS DISTINCT FROM OLD.household_id THEN
        SELECT COUNT(*) INTO n
          FROM network_dns_refresh_request
         WHERE household_id = NEW.household_id;
        IF n >= 32 THEN
            RAISE EXCEPTION 'manual refresh request bound exceeded';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
