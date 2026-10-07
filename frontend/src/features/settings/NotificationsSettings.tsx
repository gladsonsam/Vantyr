import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/api";
import { notificationQueries } from "@/api/queries/notifications";
import type { NotificationProviderInfo, NotificationTestResult } from "@/api/types";

interface NotificationsSettingsProps {
  isAdmin: boolean;
}

function EnvKey({ name }: { name: string }) {
  return (
    <code className="rounded bg-muted/70 px-1.5 py-px font-mono text-[11px] whitespace-nowrap text-muted-foreground">
      {name}
    </code>
  );
}

function ProviderRow({ p }: { p: NotificationProviderInfo }) {
  return (
    <div className="flex flex-col gap-2 border-t border-foreground/[0.06] py-3 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-bold">{p.label}</span>
        <span className={`text-xs font-medium ${p.enabled ? "text-success" : "text-muted-foreground"}`}>
          {p.enabled ? "Configured" : "Not configured"}
        </span>
        {p.docs_url ? (
          <a
            href={p.docs_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-6 items-center px-1 text-xs text-primary"
          >
            Setup guide ↗
          </a>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {p.description}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm text-muted-foreground">
          Env:
        </span>
        {p.env_keys.map((k) => (
          <EnvKey key={k} name={k} />
        ))}
      </div>
    </div>
  );
}

/** `e.message`, falling back to the value itself. */
function messageOf(e: unknown): string {
  return String((e as { message?: string })?.message ?? e);
}

export function NotificationsSettings({ isAdmin }: NotificationsSettingsProps) {
  const statusQuery = useQuery({ ...notificationQueries.status(), enabled: isAdmin });
  const providers: NotificationProviderInfo[] | null = statusQuery.isError ? null : statusQuery.data?.providers ?? null;
  const anyEnabled = statusQuery.data?.any_enabled ?? false;
  const loading = statusQuery.isFetching;
  const loadError = statusQuery.error ? messageOf(statusQuery.error) : null;
  const load = () => {
    if (!isAdmin) return;
    void statusQuery.refetch();
  };

  const test = useMutation({ mutationFn: () => api.notificationsTest() });
  const testing = test.isPending;
  const testResults: NotificationTestResult[] | null = test.data?.results ?? null;
  const testError = test.error ? messageOf(test.error) : null;
  const runTest = () => {
    if (!isAdmin) return;
    test.mutate();
  };

  const labelById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of providers ?? []) m[p.id] = p.label;
    return m;
  }, [providers]);

  const configuredCount = (providers ?? []).filter((p) => p.enabled).length;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle>
          Alert notification channels{" "}
          {providers && (
            <span className="font-mono text-sm font-normal text-muted-foreground tabular-nums">
              ({configuredCount}/{providers.length})
            </span>
          )}
        </CardTitle>
        <CardDescription>
          Fired alert rules (URL, keystroke, resource threshold, agent offline) are delivered to every
          channel configured below. Configure each channel with environment variables on the server,
          then restart. Secrets stay on the server.
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" disabled={loading || !isAdmin} onClick={() => void load()}>
            <RefreshCw /> Refresh
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-5 pb-5">
        {!isAdmin ? (
          <p className="text-sm text-muted-foreground">Administrator role required to view notification channels.</p>
        ) : loadError ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t load notification channels</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        ) : providers === null && loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading channels…
          </div>
        ) : providers ? (
          <>
            {!anyEnabled ? (
              <Alert>
                <AlertTitle>No channels configured yet</AlertTitle>
                <AlertDescription>
                  Set the environment variables for any channel below (for example{" "}
                  <code className="font-mono text-xs">SLACK_WEBHOOK_URL</code> or the
                  <code className="font-mono text-xs"> SMTP_*</code> variables) on the server and restart. See{" "}
                  <code className="font-mono text-xs">.env.example</code>.
                </AlertDescription>
              </Alert>
            ) : null}

            <div>
              {providers.map((p) => (
                <ProviderRow key={p.id} p={p} />
              ))}
            </div>

            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  disabled={!anyEnabled || testing}
                  onClick={() => void runTest()}
                >
                  {testing && <Spinner />} Send test notification
                </Button>
                <span className="text-sm text-muted-foreground">
                  {!anyEnabled
                    ? "Configure a channel first."
                    : "Delivers a sample alert to every configured channel."}
                </span>
              </div>

              {testError ? (
                <Alert variant="destructive">
                  <AlertTitle>Test failed</AlertTitle>
                  <AlertDescription>{testError}</AlertDescription>
                </Alert>
              ) : null}

              {testResults ? (
                <div className="flex flex-col gap-2">
                  {testResults.map((r) => (
                    <Alert key={r.id} variant={r.ok ? undefined : "destructive"}>
                      <AlertTitle className={r.ok ? "text-success" : undefined}>
                        {labelById[r.id] ?? r.id}: {r.ok ? "delivered" : "failed"}
                      </AlertTitle>
                      <AlertDescription>
                        {r.ok ? "Test notification sent successfully." : r.error ?? "Unknown error."}
                      </AlertDescription>
                    </Alert>
                  ))}
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
