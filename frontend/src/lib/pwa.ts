/**
 * PWA glue: service-worker registration + Web Push subscription helpers.
 *
 * The service worker (`/sw.js`) is served from the site root so its scope is `/`.
 * Push subscriptions are created against the server's VAPID key and handed to the
 * backend (`/api/push/*`); the SW's `push` handler renders the OS notification.
 */

/** Service workers + Push require a secure context (https, or http://localhost). */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Register the service worker once the page has loaded (so it never competes with
 * first paint). Safe to call unconditionally — it no-ops where SWs aren't available.
 */
export function registerServiceWorker(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  // Skip in dev over plain http on a non-localhost host (SW would fail to register).
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      // Registration failures shouldn't break the app; log for diagnosis.
      console.warn("Service worker registration failed:", err);
    });
  });
}

/** The active/ready service-worker registration, or null if unsupported. */
export async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

/** The current push subscription for this browser, if any. */
export async function getExistingSubscription(): Promise<PushSubscription | null> {
  const reg = await getRegistration();
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

/**
 * Subscribe this browser to push using the server's VAPID public key. Assumes
 * notification permission has already been granted. Returns the new subscription.
 */
export async function subscribeToPush(
  vapidPublicKey: string,
): Promise<PushSubscription> {
  const reg = await getRegistration();
  if (!reg) throw new Error("Service worker is not available.");
  // Reuse an existing subscription if present (idempotent re-enable).
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });
}

/** Unsubscribe this browser locally. Returns the endpoint that was removed (if any). */
export async function unsubscribeFromPush(): Promise<string | null> {
  const sub = await getExistingSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => undefined);
  return endpoint;
}

/**
 * Convert a base64url VAPID public key into the `Uint8Array` the Push API expects
 * for `applicationServerKey`.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  // Back the array with a concrete ArrayBuffer so it satisfies `BufferSource`.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}
