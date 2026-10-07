import { useCallback, useEffect, useState } from "react";
import { Download } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/api";
import {
  getExistingSubscription,
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
} from "@/lib/pwa";
import { useInstallPrompt } from "@/hooks/useInstallPrompt";
import { Switch } from "./SettingsSwitch";

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
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle>Browser notifications</CardTitle>
        <CardDescription>
          Get OS notifications for alert-rule matches on this device, even when the dashboard tab is closed.
          This is per-browser — enable it on each device you want notified.
        </CardDescription>
        {canInstall ? (
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => void promptInstall()}>
              <Download /> Install app
            </Button>
          </CardAction>
        ) : installed ? (
          <CardAction>
            <span className="text-sm font-medium text-success">App installed</span>
          </CardAction>
        ) : undefined}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-5 pb-5">
        {!supported ? (
          <Alert>
            <AlertTitle>Not supported on this browser</AlertTitle>
            <AlertDescription>
              This browser doesn&apos;t support push notifications, or the page isn&apos;t served over a secure
              connection (HTTPS or localhost).
            </AlertDescription>
          </Alert>
        ) : loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Checking notification status…
          </div>
        ) : !serverEnabled ? (
          <Alert>
            <AlertTitle>Web Push isn&apos;t configured on the server</AlertTitle>
            <AlertDescription>
              Set <code className="font-mono text-xs">VAPID_PUBLIC_KEY</code> and{" "}
              <code className="font-mono text-xs">VAPID_PRIVATE_KEY</code> on the server (see{" "}
              <code className="font-mono text-xs">.env.example</code>) and restart to enable browser push.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Switch
                checked={subscribed}
                disabled={busy || permission === "denied"}
                onCheckedChange={onToggle}
                aria-label="Enable browser notifications on this device"
              />
              <span className="text-sm font-medium">Enable browser notifications on this device</span>
              {busy && <Spinner />}
              <span className={`text-sm font-medium ${subscribed ? "text-success" : "text-muted-foreground"}`}>
                {subscribed ? "Subscribed" : "Not subscribed"}
              </span>
              {permission === "denied" && (
                <span className="text-sm font-medium text-destructive">Permission blocked</span>
              )}
            </div>

            {permission === "denied" && (
              <p className="text-sm text-muted-foreground">
                Notifications are blocked for this site. Re-allow them in your browser&apos;s site
                settings to enable this toggle.
              </p>
            )}
          </>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t update notifications</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
