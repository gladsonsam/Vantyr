-- Migration 0084: admit the explicit `unknown` cache state for DNS observations.
--
-- Additive correction on top of 0081. 0081 is already integrated/applied and is
-- NEVER rewritten; 0082 (settings) and 0083 (proxy) are reserved and untouched.
-- Only the cache-state CHECK on network_dns_events is replaced: a maintained
-- resolver does not expose whether a decision used its cache, so the worker
-- must be able to say `unknown` instead of fabricating a hit/miss. No row is
-- updated, no other table or constraint changes, and no other command scope is
-- granted.

ALTER TABLE network_dns_events
    DROP CONSTRAINT IF EXISTS network_dns_events_cache_bounded;

ALTER TABLE network_dns_events
    ADD CONSTRAINT network_dns_events_cache_bounded CHECK (
        cache_state IN ('hit', 'miss', 'stale', 'bypass', 'unknown')
    );

COMMENT ON COLUMN network_dns_events.cache_state IS
    'Worker-reported cache observation. unknown means the decision layer cannot observe maintained-resolver cache use; never a fabricated hit/miss.';
