-- Migration 0072: drop the AI day-narrative (`ai_generated_at` + `source = 'ai'`).
--
-- The optional OpenAI-compatible vision narrative is removed; day summaries are
-- produced only by the rule-based path (`source = 'rule'`). Existing rows whose
-- narrative was AI-generated stay readable as-is, but their source is normalized
-- to 'rule' so readers never see a source value the worker no longer produces.

UPDATE day_summaries SET source = 'rule' WHERE source = 'ai';
ALTER TABLE day_summaries DROP COLUMN IF EXISTS ai_generated_at;
