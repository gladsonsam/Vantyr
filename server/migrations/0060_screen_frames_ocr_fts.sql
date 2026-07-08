-- Migration 0060: full-text search over screen-history OCR text ("Recall" search).
--
-- Phase 2 of the screen-history feature. The agent extracts on-device OCR text per
-- keyframe (Windows.Media.Ocr); this adds a tsvector column + GIN index so the
-- dashboard can search screen contents and jump the scrubber to a matching frame.
--
-- `ocr_tsv` is populated by the server at insert time
-- (db::screen_history::insert_screen_frame computes to_tsvector('english', …)).
-- A STORED generated column is NOT used because to_tsvector is only STABLE, not
-- IMMUTABLE, so Postgres rejects it in a generation expression.

ALTER TABLE screen_frames ADD COLUMN IF NOT EXISTS ocr_tsv tsvector;

-- Partitioned GIN index → propagates to every day-partition (existing and future).
CREATE INDEX IF NOT EXISTS idx_screen_frames_ocr_tsv
    ON screen_frames USING GIN (ocr_tsv);
