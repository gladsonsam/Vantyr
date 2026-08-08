-- Migration 0066: server-controlled Recall capture settings (global + per-agent).
--
-- Capture tunables lived only in `HistorySettings::default()` on the agent, so
-- changing cadence or quality meant shipping a new agent build, and there was no way
-- to stop one machine recording without uninstalling. The code even documented a
-- server push that didn't exist ("A later phase adds a server-pushed per-agent
-- disable").
--
-- Mirrors the retention tables: a single global row, plus optional per-agent
-- overrides where NULL means "inherit the global value".
--
-- `enabled` is the operator kill switch. Agents apply it live, and cache the whole
-- settings blob in local config so it survives restarts and reconnects.

CREATE TABLE IF NOT EXISTS recall_settings_global (
    id                  SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    -- Cadence while the user is active but not actively interacting (ms).
    interval_ms         INTEGER NOT NULL DEFAULT 20000
        CHECK (interval_ms BETWEEN 1000 AND 3600000),
    -- Faster cadence while actively interacting (ms).
    hot_interval_ms     INTEGER NOT NULL DEFAULT 6000
        CHECK (hot_interval_ms BETWEEN 1000 AND 3600000),
    -- JPEG quality of the stored keyframe (1-100). Low by design: these are review
    -- thumbnails, not pixel-perfect archives.
    jpeg_quality        SMALLINT NOT NULL DEFAULT 45
        CHECK (jpeg_quality BETWEEN 1 AND 100),
    -- Longest edge after downscale (px); 0 disables downscaling.
    max_dim             INTEGER NOT NULL DEFAULT 1600
        CHECK (max_dim = 0 OR max_dim BETWEEN 320 AND 7680),
    -- Skip a frame whose average-hash is within this Hamming distance of the last
    -- stored one. 0 = only skip byte-identical scenes.
    dedup_hamming       SMALLINT NOT NULL DEFAULT 4
        CHECK (dedup_hamming BETWEEN 0 AND 64),
    -- Force a keyframe at least this often even if the screen looks unchanged, so the
    -- timelapse has coverage and "the machine was on" is provable.
    keyframe_max_gap_ms INTEGER NOT NULL DEFAULT 300000
        CHECK (keyframe_max_gap_ms BETWEEN 10000 AND 86400000),
    -- Run on-device OCR on each stored frame (makes screens searchable).
    ocr                 BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO recall_settings_global (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING;

-- Per-agent overrides. NULL in any column means "inherit the global value".
CREATE TABLE IF NOT EXISTS recall_settings_agent (
    agent_id            UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    enabled             BOOLEAN,
    interval_ms         INTEGER  CHECK (interval_ms IS NULL OR interval_ms BETWEEN 1000 AND 3600000),
    hot_interval_ms     INTEGER  CHECK (hot_interval_ms IS NULL OR hot_interval_ms BETWEEN 1000 AND 3600000),
    jpeg_quality        SMALLINT CHECK (jpeg_quality IS NULL OR jpeg_quality BETWEEN 1 AND 100),
    max_dim             INTEGER  CHECK (max_dim IS NULL OR max_dim = 0 OR max_dim BETWEEN 320 AND 7680),
    dedup_hamming       SMALLINT CHECK (dedup_hamming IS NULL OR dedup_hamming BETWEEN 0 AND 64),
    keyframe_max_gap_ms INTEGER  CHECK (keyframe_max_gap_ms IS NULL OR keyframe_max_gap_ms BETWEEN 10000 AND 86400000),
    ocr                 BOOLEAN,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
