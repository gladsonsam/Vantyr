-- Migration 0081: durable, privacy-minimal DNS query-event observations and the
-- bounded receipts that make batch ingestion replay-safe.
--
-- Additive and latest: 0073..0080 and their checksums are untouched. Nothing
-- here writes network_policies, network_dns_management_config, heartbeat
-- reports, desired assignments or BYOD state. A stored row is a WORKER
-- OBSERVATION of a DNS query on a device/network path: it is not a verified
-- person action, not proof of enforcement and not a canary/coverage signal.
-- No person id, URL, path, body, header, credential or raw ETag is stored.
--
-- The ONLY change to an accepted table is replacing the credential command
-- CHECK to allow the explicit opt-in `report_dns_events` scope. No row is
-- updated, so existing heartbeat / read_policy / dns-management credentials
-- gain nothing.

-- ─── Bounded query-event observations ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS network_dns_events (
    id                 BIGSERIAL   PRIMARY KEY,
    household_id       UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    gateway_id         UUID        NOT NULL,
    -- Worker-generated event id. Dedup key: a replay cannot create a second row
    -- or a second count within this household.
    event_id           UUID        NOT NULL,
    -- Weak device association, validated by the server against this household's
    -- assignments. NULL means unknown; a device id never identifies a person.
    device_id          UUID        NULL REFERENCES network_devices(id) ON DELETE SET NULL,
    observed_at        TIMESTAMPTZ NOT NULL,
    received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    name               TEXT        NOT NULL,
    query_type         TEXT        NOT NULL,
    protocol           TEXT        NOT NULL,
    allow              BOOLEAN     NOT NULL,
    reason_code        TEXT        NOT NULL,
    policy_revision    BIGINT      NULL CHECK (policy_revision >= 0),
    applied_rule       TEXT        NULL,
    upstream           TEXT        NULL,
    cache_state        TEXT        NOT NULL,
    flags_rd           BOOLEAN     NOT NULL DEFAULT false,
    flags_cd           BOOLEAN     NOT NULL DEFAULT false,
    flags_ra           BOOLEAN     NOT NULL DEFAULT false,
    flags_ad           BOOLEAN     NOT NULL DEFAULT false,
    filter_blocked     BOOLEAN     NOT NULL DEFAULT false,
    filter_source_id   TEXT        NULL,
    filter_source_kind TEXT        NULL,
    denied_alias_target TEXT       NULL,
    -- Optional worker correlation hint: a weak join key between observations,
    -- never a person id, evidence of a human actor or a coverage claim.
    correlation_id     TEXT        NULL,
    -- Fixed by the server; the worker cannot claim another source.
    source             TEXT        NOT NULL DEFAULT 'dns',

    CONSTRAINT network_dns_events_event_id_scope UNIQUE (household_id, event_id),
    CONSTRAINT network_dns_events_source_fixed CHECK (source = 'dns'),
    CONSTRAINT network_dns_events_name_bounded CHECK (
        length(name) BETWEEN 1 AND 253
        AND name !~* '(://|@|\?|#|[[:cntrl:]]|password|passwd|secret|token|api_key|apikey|authorization|bearer |cookie|credential|private_key|session_id)'
    ),
    CONSTRAINT network_dns_events_query_type_bounded CHECK (
        query_type IN ('A','AAAA','CNAME','SOA','TXT','MX','SRV','NS','PTR','CAA','SVCB','HTTPS','DNAME','DS','DNSKEY','ANY')
    ),
    CONSTRAINT network_dns_events_protocol_bounded CHECK (
        protocol IN ('udp','tcp','dot','doh','doq','dnscrypt','h3','unknown')
    ),
    CONSTRAINT network_dns_events_reason_bounded CHECK (
        length(reason_code) BETWEEN 1 AND 64
        AND reason_code !~* '(://|@|\?|[[:cntrl:]]|password|passwd|secret|token|api_key|apikey|authorization|bearer |cookie|credential|private_key|session_id)'
    ),
    CONSTRAINT network_dns_events_text_bounded CHECK (
        (applied_rule IS NULL OR (length(applied_rule) BETWEEN 1 AND 200
            AND applied_rule !~* '(://|@|\?|[[:cntrl:]]|password|passwd|secret|token|api_key|apikey|authorization|bearer |cookie|credential|private_key|session_id)'))
        AND (upstream IS NULL OR (length(upstream) BETWEEN 1 AND 64
            AND upstream !~* '(://|@|\?|[[:cntrl:]]|password|passwd|secret|token|api_key|apikey|authorization|bearer |cookie|credential|private_key|session_id)'))
        AND (denied_alias_target IS NULL OR (length(denied_alias_target) BETWEEN 1 AND 253
            AND denied_alias_target !~* '(://|@|\?|#|[[:cntrl:]]|password|passwd|secret|token|api_key|apikey|authorization|bearer |cookie|credential|private_key|session_id)'))
        AND (filter_source_id IS NULL OR length(filter_source_id) BETWEEN 1 AND 64)
        AND (filter_source_kind IS NULL OR filter_source_kind IN ('list','service'))
        AND (correlation_id IS NULL OR (length(correlation_id) BETWEEN 1 AND 64
            AND correlation_id !~* '(://|@|\?|[[:cntrl:]]|password|passwd|secret|token|api_key|apikey|authorization|bearer |cookie|credential|private_key|session_id)'))
    ),
    CONSTRAINT network_dns_events_cache_bounded CHECK (
        cache_state IN ('hit','miss','stale','bypass')
    ),
    -- Pin the reporting gateway to the same household as the observation.
    FOREIGN KEY (gateway_id, household_id)
        REFERENCES network_gateways(id, household_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_network_dns_events_household_time
    ON network_dns_events (household_id, observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_network_dns_events_household_name
    ON network_dns_events (household_id, name, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_network_dns_events_household_device
    ON network_dns_events (household_id, device_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_network_dns_events_household_reason
    ON network_dns_events (household_id, reason_code, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_network_dns_events_received
    ON network_dns_events (received_at DESC);

COMMENT ON TABLE network_dns_events IS
    'Bounded worker observations of DNS queries. Weak device evidence only: no person, URL, body, credential or verified/enforced state.';

-- ─── Replay-safe batch receipts (metadata only) ─────────────────────────────

CREATE TABLE IF NOT EXISTS network_dns_event_batches (
    household_id    UUID        NOT NULL REFERENCES network_households(id) ON DELETE CASCADE,
    gateway_id      UUID        NOT NULL,
    batch_id        UUID        NOT NULL,
    -- SHA-256 of the exact accepted batch bytes. An exact replay returns the
    -- original outcome; the same id with different bytes is a 409 conflict.
    body_sha256     TEXT        NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
    event_count     INTEGER     NOT NULL CHECK (event_count BETWEEN 1 AND 256),
    inserted_count  INTEGER     NOT NULL CHECK (inserted_count >= 0 AND inserted_count <= event_count),
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (household_id, gateway_id, batch_id),
    FOREIGN KEY (gateway_id, household_id)
        REFERENCES network_gateways(id, household_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_network_dns_event_batches_household_time
    ON network_dns_event_batches (household_id, received_at DESC);

COMMENT ON TABLE network_dns_event_batches IS
    'Bounded idempotency receipts for DNS event batches; digest and counts only, never raw bytes.';

-- ─── Explicit opt-in command scope (no row is updated) ───────────────────────

ALTER TABLE network_gateway_credentials
    DROP CONSTRAINT IF EXISTS network_gateway_commands_bounded;
ALTER TABLE network_gateway_credentials
    ADD CONSTRAINT network_gateway_commands_bounded CHECK (
        cardinality(allowed_commands) BETWEEN 1 AND 8
        AND allowed_commands <@ ARRAY[
            'heartbeat', 'read_policy', 'read_dns_management', 'report_dns_status',
            'report_dns_events'
        ]::text[]
    );

COMMENT ON COLUMN network_gateway_credentials.allowed_commands IS
    'Explicit command allowlist. Default issuance stays heartbeat-only; new commands are never added to existing rows.';
