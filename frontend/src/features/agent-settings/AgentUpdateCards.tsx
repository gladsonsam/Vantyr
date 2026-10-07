import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { settingsKeys, settingsQueries } from "@/api/queries/settings";
import { useServerVersionPayload } from "@/api/serverVersionStore";
import { Switch } from "@/components/common/SettingsSwitch";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@vantyr/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@vantyr/ui/components/field";
import { Spinner } from "@vantyr/ui/components/spinner";

function Facts({ items }: { items: { label: string; value: string }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-4">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg bg-muted/50 px-3.5 py-3">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="mt-1 font-mono text-[13px]">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function isOutOfDate(installed: string | null, latest: string | null): boolean {
  const norm = (v: string) => v.trim().replace(/^v/i, "");
  return !!latest && !!installed && norm(latest) !== norm(installed);
}

/** Installed vs latest agent version, with an admin "Update now" for online agents. */
export function AgentUpdateCard({
  agentId,
  agentOnline,
  agentVersion,
  isAdmin,
}: {
  agentId: string;
  agentOnline: boolean;
  agentVersion: string | null;
  isAdmin: boolean;
}) {
  const latestAgentVersion = useServerVersionPayload()?.latest_agent_version ?? null;
  const outOfDate = isOutOfDate(agentVersion, latestAgentVersion);
  const updateNow = useMutation({ mutationFn: () => api.agentUpdateNow(agentId) });

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle>Update agent</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 px-5 pb-5">
        <Facts
          items={[
            { label: "Installed", value: agentVersion ?? "—" },
            { label: "Latest", value: latestAgentVersion ?? "—" },
            { label: "Status", value: outOfDate ? "Out of date" : "Up to date (or unknown)" },
          ]}
        />

        {updateNow.error && (
          <Alert variant="destructive">
            <AlertDescription>{String(updateNow.error)}</AlertDescription>
          </Alert>
        )}
        {updateNow.isSuccess && (
          <Alert>
            <AlertDescription className="text-success">Update triggered.</AlertDescription>
          </Alert>
        )}

        {agentOnline ? (
          <div>
            <Button
              variant={outOfDate ? "default" : "outline"}
              disabled={updateNow.isPending || !isAdmin}
              onClick={() => {
                if (isAdmin) updateNow.mutate();
              }}
            >
              {updateNow.isPending && <Spinner />} Update now
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Agent offline.</p>
        )}
        {!isAdmin && <p className="text-sm text-muted-foreground">Admin only.</p>}
      </CardContent>
    </Card>
  );
}

/** Whether this agent installs updates automatically: inherited from the global default or overridden. */
export function AgentAutoUpdateCard({ agentId, isAdmin }: { agentId: string; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const autoUpdQuery = useQuery(settingsQueries.agentAutoUpdate(agentId));
  const globalEnabled: boolean | null = autoUpdQuery.data?.global.enabled ?? null;
  const override: { enabled: boolean } | null = autoUpdQuery.data?.override ?? null;

  /** `null` drops the override (back to the global default). */
  const save = useMutation({
    mutationFn: (enabled: boolean | null) =>
      enabled === null ? api.agentAutoUpdateAgentDelete(agentId) : api.agentAutoUpdateAgentPut(agentId, { enabled }),
    onSuccess: (s) => queryClient.setQueryData(settingsKeys.agentAutoUpdate(agentId), s),
  });
  const ok = save.isSuccess
    ? save.variables === null
      ? "Using global default."
      : save.data.override
        ? "Saved. Applies when the agent connects."
        : "Saved."
    : null;
  const error = save.error ?? autoUpdQuery.error;

  if (autoUpdQuery.isPending) return null;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle>Auto updates</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 px-5 pb-5">
        <Facts
          items={[
            { label: "Global default", value: globalEnabled == null ? "—" : globalEnabled ? "Enabled" : "Disabled" },
            { label: "This computer", value: override === null ? "Inherited" : override.enabled ? "Enabled" : "Disabled" },
          ]}
        />

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{String(error)}</AlertDescription>
          </Alert>
        )}
        {ok && (
          <Alert>
            <AlertDescription className="text-success">{ok}</AlertDescription>
          </Alert>
        )}

        <Field>
          <FieldLabel htmlFor="agent-auto-update">Override</FieldLabel>
          <div className="flex items-center gap-3">
            <Switch
              id="agent-auto-update"
              checked={override?.enabled ?? globalEnabled ?? true}
              disabled={save.isPending || !isAdmin}
              onCheckedChange={(checked) => {
                if (isAdmin) save.mutate(checked);
              }}
            />
            <span className="text-sm">Auto updates</span>
            {save.isPending && <Spinner />}
          </div>
          {!isAdmin && <FieldDescription>Admin only.</FieldDescription>}
        </Field>

        {override !== null ? (
          <div>
            <Button
              variant="outline"
              disabled={save.isPending || !isAdmin}
              onClick={() => {
                if (isAdmin) save.mutate(null);
              }}
            >
              Use global default
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
