-- Migration 0058: optional per-user TOTP two-factor auth for dashboard accounts.
--
-- `totp_secret` is the base32 secret (set when a user starts enrollment; the
-- account is only protected once `totp_enabled` flips true after a verified code).
-- Recovery codes are stored Argon2-hashed, single-use (marked via `used_at`).

ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS totp_secret  TEXT;
ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS dashboard_user_recovery_codes (
    id        BIGSERIAL   PRIMARY KEY,
    user_id   UUID        NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
    code_hash TEXT        NOT NULL,
    used_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_recovery_codes_user
    ON dashboard_user_recovery_codes (user_id);
