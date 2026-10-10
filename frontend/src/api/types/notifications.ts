// ── External notification channels ──────────────────────────────────────────
// Generated from the server's notification structs; see ./generated.

import type { ProviderInfo } from "./generated/ProviderInfo";
import type { TestResult } from "./generated/TestResult";

/** A supported alert-notification channel and how to configure it (no secrets). */
export type NotificationProviderInfo = ProviderInfo;

export interface NotificationsStatus {
  providers: NotificationProviderInfo[];
  any_enabled: boolean;
}

/** Per-channel result of a "send test notification" run. */
export type NotificationTestResult = TestResult;

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
