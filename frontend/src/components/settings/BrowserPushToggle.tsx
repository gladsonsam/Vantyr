import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Box, Button, Container, Header, SpaceBetween, Spinner, Toggle } from "../ui/console";
import { api } from "../../lib/api";
import {
  getExistingSubscription,
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
} from "../../lib/pwa";
import { useInstallPrompt } from "../../hooks/useInstallPrompt";

type NotifPermission = "default" | "granted" | "denied";

/**
 * Per-device controls for the PWA: install the app, and enable browser push
 * notifications for alert-rule matches on this browser. Subscription state lives
 * in the browser (Push API) and is mirrored to the server (`/api/push/*`).
 */
export function BrowserPushToggle() {
  const supported = isPushSupported();
  const { canInstall, installed, promptInstall } = useInstallPrompt();

  const [loading, setLoading] = useState(true);
  const [serverEnabled, setServerEnabled] = useState(false);
  const [vapidKey, setVapidKey] = useState<string | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [permission, setPermission] = useState<NotifPermission>(
    supported ? (Notification.permission as NotifPermission) : "default",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supported) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [key, existing] = await Promise.all([
        api.pushVapidPublicKey(),
        getExistingSubscription(),
      ]);
      setServerEnabled(key.enabled);
      setVapidKey(key.publicKey);
      setSubscribed(Boolean(existing));
      setPermission(Notification.permission as NotifPermission);
    } catch (e: unknown) {
      setError(String((e as { message?: string })?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [supported]);

  useEffect(() => {
    void load();
  }, [load]);

  const enable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const perm = (await Notification.requestPermission()) as NotifPermission;
      setPermission(perm);
      if (perm !== "granted") {
        setError(
          perm === "denied"
            ? "Notifications are blocked for this site. Allow them in your browser's site settings, then try again."
            : "Notification permission was not granted.",
        );
        return;
      }
      if (!vapidKey) throw new Error("Server VAPID key unavailable.");
      const sub = await subscribeToPush(vapidKey);
      const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error("Browser returned an incomplete push subscription.");
      }
      await api.pushSubscribe({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      });
      setSubscribed(true);
    } catch (e: unknown) {
      setError(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [vapidKey]);

  const disable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const endpoint = await unsubscribeFromPush();
      if (endpoint) await api.pushUnsubscribe(endpoint);
      setSubscribed(false);
    } catch (e: unknown) {
      setError(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, []);

  const onToggle = useCallback(
    (checked: boolean) => {
      if (busy) return;
      if (checked) void enable();
      else void disable();
    },
    [busy, enable, disable],
  );

  return (
    <Container
      header={
        <Header
          variant="h2"
          description="Get OS notifications for alert-rule matches on this device, even when the dashboard tab is closed. This is per-browser — enable it on each device you want notified."
          actions={
            canInstall ? (
              <Button iconName="add-plus" onClick={() => void promptInstall()}>
                Install app
              </Button>
            ) : installed ? (
              <Badge color="green">App installed</Badge>
            ) : undefined
          }
        >
          Browser notifications
        </Header>
      }
    >
      <SpaceBetween size="m">
        {!supported ? (
          <Alert type="info" header="Not supported on this browser">
            This browser doesn't support push notifications, or the page isn't served over a secure
            connection (HTTPS or localhost).
          </Alert>
        ) : loading ? (
          <Box color="text-body-secondary">
            <Spinner size="normal" /> Checking notification status…
          </Box>
        ) : !serverEnabled ? (
          <Alert type="info" header="Web Push isn't configured on the server">
            Set <code>VAPID_PUBLIC_KEY</code> and <code>VAPID_PRIVATE_KEY</code> on the server (see{" "}
            <code>.env.example</code>) and restart to enable browser push.
          </Alert>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <Toggle
                checked={subscribed}
                disabled={busy || permission === "denied"}
                onChange={({ detail }) => onToggle(detail.checked)}
              >
                Enable browser notifications on this device
              </Toggle>
              {busy ? <Spinner size="normal" /> : null}
              <Badge color={subscribed ? "green" : "grey"}>
                {subscribed ? "Subscribed" : "Not subscribed"}
              </Badge>
              {permission === "denied" ? <Badge color="red">Permission blocked</Badge> : null}
            </div>

            {permission === "denied" ? (
              <Box fontSize="body-s" color="text-body-secondary">
                Notifications are blocked for this site. Re-allow them in your browser's site
                settings to enable this toggle.
              </Box>
            ) : null}
          </>
        )}

        {error ? (
          <Alert type="error" dismissible onDismiss={() => setError(null)} header="Couldn't update notifications">
            {error}
          </Alert>
        ) : null}
      </SpaceBetween>
    </Container>
  );
}
