-- Migration 0061: derived screen-history narrative — activity segments + day summaries.
--
-- Phase 3 (Dayflow-style "what did I do today"). A background worker batches recent
-- keyframes + existing telemetry (window_events / url_visits) into contiguous
-- activity segments and a per-day summary. Rule-based categorization is the
-- baseline; an optional OpenAI-compatible vision model enriches the narrative.
--
-- These are DERIVED and low-volume (not partitioned). They are rebuilt idempotently
-- per (agent, day) by the worker and pruned alongside their source frames.

CREATE TABLE IF NOT EXISTS activity_segments (
    id                BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_id          UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    start_ts          TIMESTAMPTZ NOT NULL,
    end_ts            TIMESTAMPTZ NOT NULL,
    -- Coarse category: dev | browsing | comms | docs | media | design | terminal | other.
    category          TEXT        NOT NULL,
    app               TEXT,
    title             TEXT,
    summary           TEXT,
    -- 0.0 (focused/productive) … 1.0 (distraction). Heuristic per category.
    distraction_score REAL        NOT NULL DEFAULT 0,
    frame_start_id    BIGINT,
    frame_end_id      BIGINT,
    -- 'rule' | 'ai' — how this segment's summary was produced.
    source            TEXT        NOT NULL DEFAULT 'rule',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_segments_agent_start
    ON activity_segments (agent_id, start_ts);

CREATE TABLE IF NOT EXISTS day_summaries (
    agent_id   UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    day        DATE        NOT NULL,
    narrative  TEXT,
    -- { active_seconds, by_category: {cat: seconds}, segment_count, ... }
    totals     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    -- [ { app, seconds } … ] descending.
    top_apps   JSONB       NOT NULL DEFAULT '[]'::jsonb,
    -- [ { label, start_ts, end_ts } … ] notable stretches.
    highlights JSONB       NOT NULL DEFAULT '[]'::jsonb,
    source     TEXT        NOT NULL DEFAULT 'rule',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agent_id, day)
);
