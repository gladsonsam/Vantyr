import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Spinner } from "@vantyr/ui/components/spinner";
import { api, errorText } from "@/api";
import { notificationQueries } from "@/api/queries/notifications";
import type { NotificationProviderInfo, NotificationTestResult } from "@/api/types";
import { RefreshButton } from "@/components/common/RefreshButton";
import { SettingsCardBody, SettingsSection } from "./components/SettingsLayout";

interface NotificationsSettingsProps {
  isAdmin: boolean;
}

function EnvKey({ name }: { name: string }) {
  return (
    <code className="rounded bg-muted/70 px-1.5 py-px font-sans text-[11px] break-all text-muted-foreground">
      {name}
    </code>
  );
}

function SetupGuide({ url, label }: { url: string; label: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-h-6 items-center text-xs text-primary underline-offset-4 hover:underline"
      aria-label={`${label} setup guide (opens in a new tab)`}
    >
      Setup guide ↗
    </a>
  );
}

/** A channel that delivers alerts: its name and, when there is one, its setup guide. */
function ConfiguredRow({ p }: { p: NotificationProviderInfo }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
      <Check aria-hidden="true" className="size-4 shrink-0 text-success" />
      <span className="font-medium">{p.label}</span>
      <span className="text-xs font-medium text-success">Configured</span>
      {p.docs_url ? <SetupGuide url={p.docs_url} label={p.label} /> : null}
    </li>
  );
}

/** A channel that is not set up: what it is and which server variables turn it on. */
function UnconfiguredRow({ p }: { p: NotificationProviderInfo }) {
  return (
    <li className="flex flex-col gap-1.5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{p.label}</span>
        {p.docs_url ? <SetupGuide url={p.docs_url} label={p.label} /> : null}
      </div>
      <p className="text-sm text-muted-foreground">{p.description}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm text-muted-foreground">Server variables:</span>
        {p.env_keys.map((k) => (
          <EnvKey key={k} name={k} />
        ))}
      </div>
    </li>
  );
}

function TestResults({
  results,
  labels,
}: {
  results: NotificationTestResult[];
  labels: Record<string, string>;
}) {
  return (
    <div className="flex flex-col gap-2" role="status">
      {results.map((r) => (
        <Alert key={r.id} variant={r.ok ? undefined : "destructive"}>
          <AlertTitle className={r.ok ? "text-success" : undefined}>
            {labels[r.id] ?? r.id}: {r.ok ? "test message sent" : "failed"}
          </AlertTitle>
          {!r.ok && <AlertDescription>{r.error ?? "Unknown error."}</AlertDescription>}
        </Alert>
      ))}
    </div>
  );
}

type StatusQuery = ReturnType<typeof useStatusQuery>;
function useStatusQuery(isAdmin: boolean) {
  return useQuery({ ...notificationQueries.status(), enabled: isAdmin });
}

function RefreshNotice({ query, children }: { query: StatusQuery; children: string }) {
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>{children}</span>
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** The sending side: one test button and what each channel answered. */
function ChannelTest({
  configured,
  labels,
}: {
  configured: number;
  labels: Record<string, string>;
}) {
  const test = useMutation({ mutationFn: () => api.notificationsTest() });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button disabled={configured === 0 || test.isPending} onClick={() => test.mutate()}>
          {test.isPending && <Spinner />} Send test notification
        </Button>
        <span className="text-sm text-muted-foreground">
          {configured === 0
            ? "Set up a channel first."
            : `Sends a real message to ${configured === 1 ? "this channel" : `all ${configured} channels`}.`}
        </span>
      </div>
      {test.error ? (
        <Alert variant="destructive">
          <AlertTitle>Test failed</AlertTitle>
          <AlertDescription>{errorText(test.error)}</AlertDescription>
        </Alert>
      ) : null}
      {test.data?.results ? <TestResults results={test.data.results} labels={labels} /> : null}
    </div>
  );
}

function ChannelList({
  providers,
  query,
}: {
  providers: NotificationProviderInfo[];
  query: StatusQuery;
}) {
  const configured = providers.filter((p) => p.enabled);
  const unconfigured = providers.filter((p) => !p.enabled);
  const labels = useMemo(
    () => Object.fromEntries(providers.map((p) => [p.id, p.label])),
    [providers],
  );
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {configured.length === 0
          ? `No channel is set up yet. ${providers.length} are available.`
          : `${configured.length} of ${providers.length} channels set up.`}
      </p>
      {query.isError && (
        <RefreshNotice query={query}>
          Couldn&apos;t refresh, so this list may be out of date.
        </RefreshNotice>
      )}
      {configured.length > 0 && (
        <ul className="divide-y divide-border/50 rounded-xl border border-border/70 px-4">
          {configured.map((p) => (
            <ConfiguredRow key={p.id} p={p} />
          ))}
        </ul>
      )}
      {unconfigured.length > 0 && (
        <details
          className="group rounded-xl border border-border/70 px-4 py-3"
          open={configured.length === 0 ? true : undefined}
        >
          <summary className="cursor-pointer text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {configured.length === 0 ? "Available channels" : "Not set up"} ({unconfigured.length})
          </summary>
          <ul className="divide-y divide-border/50 pt-2">
            {unconfigured.map((p) => (
              <UnconfiguredRow key={p.id} p={p} />
            ))}
          </ul>
        </details>
      )}
      <ChannelTest configured={configured.length} labels={labels} />
    </>
  );
}

function ChannelsBody({ isAdmin, query }: { isAdmin: boolean; query: StatusQuery }) {
  if (!isAdmin)
    return (
      <p className="text-sm text-muted-foreground">Only admins can see and test alert channels.</p>
    );
  const providers = query.data?.providers ?? null;
  if (providers) return <ChannelList providers={providers} query={query} />;
  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load alert channels</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
          <span>{errorText(query.error)}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner /> Loading channels…
    </div>
  );
}

export function NotificationsSettings({ isAdmin }: NotificationsSettingsProps) {
  const statusQuery = useStatusQuery(isAdmin);
  return (
    <SettingsSection
      title="Alert channels"
      help={
        <>
          Fired alert rules (URL, keystroke, resource threshold, agent offline) are delivered to
          every channel configured here. Set a channel&apos;s variables in the server environment
          (see <code className="font-sans">.env.example</code>), then restart. Secrets stay on the
          server.
        </>
      }
      action={
        isAdmin ? (
          <RefreshButton
            onClick={() => void statusQuery.refetch()}
            loading={statusQuery.isFetching}
            label="Refresh channels"
          />
        ) : undefined
      }
    >
      <SettingsCardBody className="space-y-4">
        <ChannelsBody isAdmin={isAdmin} query={statusQuery} />
      </SettingsCardBody>
    </SettingsSection>
  );
}
