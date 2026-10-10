import type { NotificationsStatus, NotificationsTestResponse, PushSubscribeBody, PushVapidKey } from "@/api/types";
import { get, postEmpty, postJsonRes } from "@/api/client";

export const notificationsEndpoints = {
  /** Admin: external notification channels and their configured state (no secrets). */
  notificationsStatus: (): Promise<NotificationsStatus> => get("/settings/notifications"),

  /** Admin: fire a synthetic alert through every configured channel. */
  notificationsTest: (): Promise<NotificationsTestResponse> =>
    postEmpty("/settings/notifications/test"),

  /** Web Push: the server VAPID public key (for `applicationServerKey`) and whether push is configured. */
  pushVapidPublicKey: (): Promise<PushVapidKey> => get("/push/vapid-public-key"),

  /** Web Push: register this browser's push subscription for the signed-in user. */
  pushSubscribe: (body: PushSubscribeBody): Promise<{ ok: boolean }> =>
    postJsonRes("/push/subscribe", body),

  /** Web Push: remove this browser's push subscription by endpoint. */
  pushUnsubscribe: (endpoint: string): Promise<{ ok: boolean }> =>
    postJsonRes("/push/unsubscribe", { endpoint }),
};
