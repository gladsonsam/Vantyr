import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@vantyr/ui/components/card";
import { Spinner } from "@vantyr/ui/components/spinner";
import { api, errorText } from "@/api";
import { getExistingSubscription, isPushSupported, subscribeToPush } from "@/lib/pwa";
import { useInstallPrompt } from "@/hooks/useInstallPrompt";
import { Switch } from "@/components/common/SettingsSwitch";
import { HelpTip } from "@/components/common/HelpTip";

type NotifPermission = "default" | "granted" | "denied";

interface PushStatus {
  serverEnabled: boolean;
  publicKey: string | null;
  subscribed: boolean;
  permission: NotifPermission;
}

/** Local to this browser: the Push subscription and permission are never read from the server. */
const pushStatusKey = ["push", "browser-status"] as const;

async function fetchPushStatus(): Promise<PushStatus> {
  const [key, existing] = await Promise.all([api.pushVapidPublicKey(), getExistingSubscription()]);
  return {
    serverEnabled: key.enabled,
    publicKey: key.publicKey,
    subscribed: Boolean(existing),
    permission: Notification.permission as NotifPermission,
  };
}

async function registerPushSubscription(publicKey: string): Promise<void> {
  const sub = await subscribeToPush(publicKey);
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("Browser returned an incomplete push subscription.");
  }
  await api.pushSubscribe({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
}

/** Tells the server first, so a refused request leaves this browser still subscribed and the switch still honest. */
async function removePushSubscription(): Promise<void> {
  const sub = await getExistingSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint);
  await sub.unsubscribe().catch(() => undefined);
}

function usePushToggle(supported: boolean) {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: pushStatusKey, queryFn: fetchPushStatus, enabled: supported });
  const [notice, setNotice] = useState<string | null>(null);

  // Whatever happened, the browser is the source of truth: read it again rather than assume.
  // Returning the promise keeps the action pending until the new state is in, so the switch never flickers.
  const reread = () => queryClient.invalidateQueries({ queryKey: pushStatusKey });

  const enable = useMutation({
    mutationFn: async () => {
      const permission = (await Notification.requestPermission()) as NotifPermission;
      if (permission !== "granted") return permission;
      const key = status.data?.publicKey;
      if (!key) throw new Error("The server has no push key to subscribe with.");
      await registerPushSubscription(key);
      return permission;
    },
    onSuccess: (permission) => {
      if (permission === "denied") setNotice("Notifications are blocked for this site. Allow them in your browser's site settings, then turn this on again.");
      else if (permission === "default") setNotice("Permission wasn't given, so nothing was turned on. Turn this on again and choose Allow.");
    },
    onSettled: reread,
  });
  const disable = useMutation({ mutationFn: removePushSubscription, onSettled: reread });

  return {
    status,
    notice,
    enable,
    disable,
    busy: enable.isPending || disable.isPending,
    toggle: (checked: boolean) => {
      if (enable.isPending || disable.isPending) return;
      setNotice(null);
      enable.reset();
      disable.reset();
      if (checked) enable.mutate();
      else disable.mutate();
    },
  };
}

type PushToggle = ReturnType<typeof usePushToggle>;

function StatusLoadFailed({ toggle }: { toggle: PushToggle }) {
  const { status } = toggle;
  return (
    <Alert variant="destructive">
      <AlertTitle>Couldn&apos;t check notification status</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>{errorText(status.error)}</span>
        <Button variant="outline" size="sm" disabled={status.isFetching} onClick={() => void status.refetch()}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function PushSwitch({ toggle, data }: { toggle: PushToggle; data: PushStatus }) {
  const { status, enable, disable, busy, notice } = toggle;
  const state = enable.isPending ? "Turning on…" : disable.isPending ? "Turning off…" : data.subscribed ? "On" : "Off";
  return (
    <>
      {status.isError && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>Couldn&apos;t re-check this browser, so the state below may be out of date.</span>
            <Button variant="outline" size="sm" disabled={status.isFetching} onClick={() => void status.refetch()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Switch
          checked={data.subscribed}
          disabled={busy || (data.permission === "denied" && !data.subscribed)}
          onCheckedChange={toggle.toggle}
          aria-label="Alert notifications on this browser"
        />
        <span className="text-sm font-medium">Alert notifications on this browser</span>
        {busy && <Spinner />}
        <span className={`text-sm font-medium ${data.subscribed ? "text-success" : "text-muted-foreground"}`}>{state}</span>
      </div>
      {data.permission === "denied" && (
        <p className="text-sm text-muted-foreground">
          Notifications are blocked for this site. Allow them in your browser&apos;s site settings to turn this on.
        </p>
      )}
      {notice && data.permission !== "denied" && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    </>
  );
}

function PushBody({ supported, toggle }: { supported: boolean; toggle: PushToggle }) {
  const data = toggle.status.data;
  if (!supported) {
    return (
      <Alert>
        <AlertTitle>Not supported on this browser</AlertTitle>
        <AlertDescription>This browser can&apos;t receive push notifications here (it needs HTTPS).</AlertDescription>
      </Alert>
    );
  }
  if (!data) {
    return toggle.status.isError ? (
      <StatusLoadFailed toggle={toggle} />
    ) : (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Checking notification status…
      </div>
    );
  }
  if (!data.serverEnabled) {
    return (
      <Alert>
        <AlertTitle>Browser push isn&apos;t set up on the server</AlertTitle>
        <AlertDescription>
          Set <code className="font-mono text-xs">VAPID_PUBLIC_KEY</code> and <code className="font-mono text-xs">VAPID_PRIVATE_KEY</code> in
          the server environment (see <code className="font-mono text-xs">.env.example</code>) and restart to enable browser push.
        </AlertDescription>
      </Alert>
    );
  }
  return <PushSwitch toggle={toggle} data={data} />;
}

/**
 * Per-device controls for the PWA: install the app, and enable browser push
 * notifications for alert-rule matches on this browser. Subscription state lives
 * in the browser (Push API) and is mirrored to the server (`/api/push/*`).
 */
export function BrowserPushToggle() {
  const supported = isPushSupported();
  const { canInstall, installed, promptInstall } = useInstallPrompt();
  const toggle = usePushToggle(supported);
  const actionError = toggle.enable.error ?? toggle.disable.error;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="flex items-center gap-1.5">
          Browser notifications
          <HelpTip>
            Get OS notifications for alert-rule matches on this device, even when the dashboard tab is closed. This is per-browser:
            turn it on in each browser you want notified.
          </HelpTip>
        </CardTitle>
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
        <PushBody supported={supported} toggle={toggle} />
        {actionError && (
          <Alert variant="destructive">
            <AlertTitle>{toggle.enable.error ? "Couldn't turn on notifications" : "Couldn't turn off notifications"}</AlertTitle>
            <AlertDescription>{errorText(actionError)}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
