-- Migration 0065: make the Recall day-narrative worker incremental.
--
-- The worker rebuilt every agent's *entire* day every 15 minutes, including the
-- optional vision-model call. That meant the AI cost for a single day grew with the
-- number of ticks in it (~96 full-day calls per agent per day), and it only ever
-- looked at "today" — so if the server was down or restarting at the end of a day,
-- that day's final hours were never summarized and nothing ever went back to fix it.
--
-- These columns let the worker skip work that would produce an identical result:
--
--   content_hash   Fingerprint of the segments the summary was derived from. Unchanged
--                  hash => nothing happened since the last run => skip entirely.
--   ai_generated_at When the vision narrative was last produced, so AI calls can be
--                  rate-limited independently of the cheap rule-based rebuild.
--   finalized      Set once the day is over and has been summarized one last time.
--                  Finalized days are skipped on subsequent ticks, which is what makes
--                  backfilling previous days cheap enough to do on every tick.

ALTER TABLE day_summaries ADD COLUMN IF NOT EXISTS content_hash    TEXT;
ALTER TABLE day_summaries ADD COLUMN IF NOT EXISTS ai_generated_at TIMESTAMPTZ;
ALTER TABLE day_summaries ADD COLUMN IF NOT EXISTS finalized       BOOLEAN NOT NULL DEFAULT FALSE;
