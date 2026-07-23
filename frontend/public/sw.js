/*
 * Vantyr service worker (hand-rolled — no vite-plugin-pwa).
 *
 * Caching strategy:
 *   - Navigations  → network-first (always try the live SPA shell; fall back to the
 *     cached shell when offline) so a deploy is picked up immediately.
 *   - /assets/*    → cache-first. Vite fingerprints these filenames (content hash),
 *     so a given URL is immutable and safe to serve from cache forever.
 *   - everything else → passthrough to the network.
 *
 * Plus Web Push: `push` shows an OS notification, `notificationclick` focuses/opens
 * the deep link carried in the payload.
 */

const CACHE_VERSION = "v1";
const SHELL_CACHE = `vantyr-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `vantyr-assets-${CACHE_VERSION}`;
const SHELL_URL = "/index.html";

self.addEventListener("install", (event) => {
  // Warm the app shell so the first offline navigation still renders.
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.add(SHELL_URL))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Only handle same-origin requests; let the browser deal with cross-origin.
  if (url.origin !== self.location.origin) return;

  // SPA navigations: network-first, fall back to the cached shell when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(SHELL_URL, copy));
          return res;
        })
        .catch(() =>
          caches.match(SHELL_URL).then((cached) => cached || caches.match(request))
        )
    );
    return;
  }

  // Fingerprinted build assets are immutable: serve from cache, populate on miss.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(ASSET_CACHE).then((cache) =>
        cache.match(request).then(
          (cached) =>
            cached ||
            fetch(request).then((res) => {
              if (res.ok) cache.put(request, res.clone());
              return res;
            })
        )
      )
    );
  }
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Vantyr", body: event.data ? event.data.text() : "" };
  }

  const title = payload.title || payload.rule_name || "Vantyr alert";
  const body =
    payload.body ||
    [payload.snippet, payload.agent_name].filter(Boolean).join(" — ") ||
    "New alert";
  const url = payload.url || payload.dashboard_activity_url || "/";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "vantyr-alert",
      data: { url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        // Focus an existing dashboard tab if one is open, otherwise open a new one.
        for (const client of clients) {
          const sameOrigin = new URL(client.url).origin === self.location.origin;
          if (sameOrigin && "focus" in client) {
            client.navigate(target).catch(() => undefined);
            return client.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(target);
        return undefined;
      })
  );
});
