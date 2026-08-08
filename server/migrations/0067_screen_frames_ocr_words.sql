-- Migration 0067: per-word OCR geometry, so replayed screens have selectable text.
--
-- The agent already ran on-device OCR on every keyframe, but only the flattened
-- string was kept — enough to search for a frame, not enough to point at anything on
-- it. Windows' OCR returns a bounding box per word; storing those lets the dashboard
-- lay invisible, correctly-positioned spans over a replayed frame, so text on a
-- screen from three weeks ago can be selected, copied, and clicked like a web page.
--
-- Shape: `[{"t": "word", "x": 0.12, "y": 0.34, "w": 0.05, "h": 0.02}, ...]` with
-- coordinates normalized to 0..1 of the stored frame, so the overlay positions
-- correctly at any rendered size without knowing the capture resolution.
--
-- Deliberately NOT indexed: this column is never queried, only fetched by frame id
-- alongside the blob. Text search continues to use the `ocr_tsv` GIN index from 0060.
-- Nullable because frames captured before this migration have no geometry, and
-- because OCR can legitimately find nothing on a frame.

ALTER TABLE screen_frames ADD COLUMN IF NOT EXISTS ocr_words JSONB;
