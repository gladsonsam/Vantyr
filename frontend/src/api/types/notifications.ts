// ── External notification channels ──────────────────────────────────────────

/** A supported alert-notification channel and how to configure it (no secrets). */
export interface NotificationProviderInfo {
  id: string;
  label: string;
  description: string;
  /** Server environment variables that configure this channel. */
  env_keys: string[];
  /** Documentation link, or "" when there isn't one. */
  docs_url: string;
  /** Whether the channel is currently configured (its env vars are set). */
  enabled: boolean;
}

export interface NotificationsStatus {
  providers: NotificationProviderInfo[];
  any_enabled: boolean;
}

/** Per-channel result of a "send test notification" run. */
export interface NotificationTestResult {
  id: string;
  ok: boolean;
  error: string | null;
}

export interface NotificationsTestResponse {
  results: NotificationTestResult[];
  all_ok: boolean;
}

/** Web Push: server VAPID public key and whether browser push is configured. */
export interface PushVapidKey {
  publicKey: string | null;
  enabled: boolean;
}

/** Web Push: a browser `PushSubscription` (as produced by `subscription.toJSON()`). */
export interface PushSubscribeBody {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}
