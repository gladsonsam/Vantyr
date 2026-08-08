-- Migration 0064: drop the never-populated frame-reference columns on activity_segments.
--
-- `frame_start_id` / `frame_end_id` were added in 0061 to link a derived activity
-- segment to its bounding keyframes, but nothing ever wrote them — the narrative
-- worker builds segments from `window_events` and never resolves frame ids, so every
-- row has had NULLs since the table was created.
--
-- The UI navigates by timestamp instead (`jumpToFrame` binary-searches the loaded
-- frame list), which works across reloads and doesn't break when retention drops the
-- partition holding the referenced frame. Dropping the columns removes a schema
-- element that reads as a working foreign reference but isn't one.
--
-- Safe: no data is lost because no data was ever written. If segment→frame linking is
-- wanted later it should be re-added with the worker populating it in the same change.

ALTER TABLE activity_segments DROP COLUMN IF EXISTS frame_start_id;
ALTER TABLE activity_segments DROP COLUMN IF EXISTS frame_end_id;
