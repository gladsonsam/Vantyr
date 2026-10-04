-- Additive observations only: old rows remain NULL, no inferred/backfilled context.
ALTER TABLE screen_frames ADD COLUMN capture_duration_ms INTEGER
    CHECK (capture_duration_ms BETWEEN 0 AND 1000);
ALTER TABLE screen_frames ADD COLUMN capture_context JSONB;
ALTER TABLE screen_frames ADD COLUMN context_app TEXT;
ALTER TABLE screen_frames ADD COLUMN context_title TEXT COLLATE "C";
ALTER TABLE screen_frames ADD COLUMN context_url_host TEXT;
CREATE UNIQUE INDEX idx_screen_frames_agent_client_uid
    ON screen_frames (agent_id, captured_at, client_uid);
DROP INDEX idx_screen_frames_client_uid;
CREATE INDEX idx_screen_frames_context_app
    ON screen_frames (agent_id, context_app, captured_at DESC, id DESC)
    WHERE context_app IS NOT NULL;
CREATE INDEX idx_screen_frames_context_host
    ON screen_frames (agent_id, context_url_host, captured_at DESC, id DESC)
    WHERE context_url_host IS NOT NULL;
