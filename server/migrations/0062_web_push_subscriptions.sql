-- Migration 0062: Web Push (browser) subscriptions for PWA notifications.
--
-- Each row is one browser/device push subscription obtained from the Push API
-- (`PushManager.subscribe`), scoped to the dashboard user who registered it.
-- `endpoint` is the push service URL and is globally unique (one subscription per
-- browser endpoint). `p256dh`/`auth` are the base64url client keys used to encrypt
-- payloads (RFC 8291). `failure_count`/`last_success_at` support pruning dead subs.

CREATE TABLE IF NOT EXISTS web_push_subscriptions (
    id              BIGSERIAL   PRIMARY KEY,
    user_id         UUID        NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
    endpoint        TEXT        NOT NULL UNIQUE,
    p256dh          TEXT        NOT NULL,
    auth            TEXT        NOT NULL,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_success_at TIMESTAMPTZ,
    failure_count   INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_user
    ON web_push_subscriptions (user_id);
