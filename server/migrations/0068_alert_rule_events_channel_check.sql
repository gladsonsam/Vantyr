-- Migration 0068: let `alert_rule_events.channel` accept every channel `alert_rules` can fire on.
--
-- 0057 widened `alert_rules.channel` to include 'url_category', 'agent_offline'
-- and 'resource', but left this table's CHECK constraint from 0019 at
-- ('url', 'keys'). The engine inserts an event for every match, so any firing on
-- one of the three newer channels failed the constraint:
--
--   WARN alert_rule_event_insert failed
--        error returned from database: new row for relation "alert_rule_events"
--        violates check constraint "alert_rule_events_channel_check"
--
-- The alert still reached connected viewers and external notifications (those are
-- driven from the in-memory broadcast, before the insert), but it was never
-- persisted, so it was missing from the history the dashboard reads
-- ("Alert events", per-agent alerts, per-rule history) with no indication
-- anything had gone wrong.
--
-- Fix: widen the constraint to the same set 0057 uses for alert_rules.

ALTER TABLE alert_rule_events
    DROP CONSTRAINT IF EXISTS alert_rule_events_channel_check;

ALTER TABLE alert_rule_events
    ADD CONSTRAINT alert_rule_events_channel_check
    CHECK (channel IN ('url', 'keys', 'url_category', 'agent_offline', 'resource'));