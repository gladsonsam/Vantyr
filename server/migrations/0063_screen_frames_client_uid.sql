-- Migration 0063: idempotent keyframe ingest (`client_uid`) for the Recall spool.
--
-- The agent no longer hands keyframes straight to the session socket (where every
-- frame captured while disconnected was dropped). It writes them to a durable
-- on-disk spool and deletes each only after the server acks it. That makes the
-- ingest path at-least-once: a lost ack, or a session that dies between insert and
-- ack, causes the agent to re-send the same keyframe on its next connection.
--
-- `client_uid` is the agent-generated id for a spooled frame. The unique index makes
-- the re-send a no-op (`ON CONFLICT DO NOTHING`) instead of a duplicate row.
--
-- The partition key must be part of every unique constraint on a partitioned table,
-- so the index is on (captured_at, client_uid) rather than client_uid alone. That is
-- still exactly the dedup we need: a re-sent frame carries its original captured_at.
--
-- Nullable because frames ingested before this migration have no uid, and because a
-- future non-spooling client could omit it; NULLs are never equal in a unique index,
-- so they simply don't participate in dedup.

ALTER TABLE screen_frames ADD COLUMN IF NOT EXISTS client_uid UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_screen_frames_client_uid
    ON screen_frames (captured_at, client_uid);
