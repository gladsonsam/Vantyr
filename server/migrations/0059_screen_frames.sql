-- Migration 0059: screen history keyframes ("Recall" DVR).
--
-- The agent (when server-enabled) streams "history_frame" events: a downscaled
-- JPEG keyframe captured on meaningful change (window/URL focus or an active
-- heartbeat), plus a perceptual hash and optional on-device OCR text. This table
-- is the *index*: the JPEG bytes live in the filesystem blob store
-- (SCREEN_HISTORY_DIR); only `blob_ref` (a relative path) is stored here.
--
-- Volume note: this is the highest-cardinality table in the schema (potentially
-- thousands of rows/agent/day). It is therefore PARTITIONED BY DAY so retention
-- can DROP whole partitions instantly instead of the row-by-row DELETE loop used
-- for the other telemetry heaps. Day partitions are created on demand at ingest
-- (see db::screen_history::ensure_screen_frame_partition); this migration creates
-- only the parent and a DEFAULT catch-all so inserts never fail if the on-demand
-- partition creation is skipped.

CREATE TABLE IF NOT EXISTS screen_frames (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY,
    agent_id    UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    captured_at TIMESTAMPTZ NOT NULL,
    monitor     INT         NOT NULL DEFAULT 0,
    w           INT         NOT NULL,
    h           INT         NOT NULL,
    -- u64 aHash reinterpreted as i64 bits (the agent sends it as a decimal string
    -- because JS can't hold a full u64; the server parses u64 then casts to i64).
    phash       BIGINT      NOT NULL,
    -- Relative path under SCREEN_HISTORY_DIR, e.g. "<agent>/20260707/<uuid>.jpg".
    blob_ref    TEXT        NOT NULL,
    ocr_text    TEXT,
    -- Partition key must be part of every unique constraint, so the PK is composite.
    PRIMARY KEY (captured_at, id)
) PARTITION BY RANGE (captured_at);

-- Catch-all so an insert can never fail before its day partition exists. Retention
-- drops per-day partitions; rows that land here (should be rare) are pruned by age.
CREATE TABLE IF NOT EXISTS screen_frames_default PARTITION OF screen_frames DEFAULT;

-- Primary read path: scrub/timelapse over a time range for one agent.
CREATE INDEX IF NOT EXISTS idx_screen_frames_agent_ts
    ON screen_frames (agent_id, captured_at DESC);

-- Blob endpoint looks a frame up by its global id (across partitions).
CREATE INDEX IF NOT EXISTS idx_screen_frames_id
    ON screen_frames (id);
