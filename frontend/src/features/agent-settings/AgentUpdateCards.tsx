import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { settingsKeys, settingsQueries } from "@/api/queries/settings";
import { useServerVersionPayload } from "@/api/serverVersionStore";
import { isNewerVersion, normalizeVersion } from "@/features/fleet/lib/fleetUtils";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@vantyr/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@vantyr/ui/components/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@vantyr/ui/components/select";
import { Spinner } from "@vantyr/ui/components/spinner";

/** Installed version against the latest, with an admin "Update now" when a newer one exists. */
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
  const outOfDate = isNewerVersion(latestAgentVersion, agentVersion);
  const updateNow = useMutation({ mutationFn: () => api.agentUpdateNow(agentId) });
  const status = !agentVersion || !latestAgentVersion
    ? { text: "Latest version unknown", tone: "text-muted-foreground" }
    : outOfDate
      ? { text: `v${normalizeVersion(latestAgentVersion)} available`, tone: "text-warning" }
      : { text: "Up to date", tone: "text-success" };

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle>Agent version</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-5 pb-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-lg font-semibold tabular-nums">{agentVersion ? `v${normalizeVersion(agentVersion)}` : "Unknown"}</span>
          <span className={`text-sm ${status.tone}`}>{status.text}</span>
        </div>

        {updateNow.error && (
          <Alert variant="destructive">
            <AlertDescription>{String(updateNow.error)}</AlertDescription>
          </Alert>
        )}
        {updateNow.isSuccess && <p className="text-sm text-success">Update started.</p>}

        {outOfDate && isAdmin && (
          <div>
            <Button disabled={updateNow.isPending || !agentOnline} onClick={() => updateNow.mutate()}>
              {updateNow.isPending && <Spinner />} Update now
            </Button>
            {!agentOnline && <p className="mt-2 text-sm text-muted-foreground">Available when the device is online.</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type AutoUpdateChoice = "inherit" | "on" | "off";

/** Whether this agent installs updates by itself: the global default, or forced on or off here. */
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
  const error = save.error ?? autoUpdQuery.error;

  if (autoUpdQuery.isPending) return null;

  const choice: AutoUpdateChoice = override === null ? "inherit" : override.enabled ? "on" : "off";
  const defaultLabel = globalEnabled == null ? "Server default" : `Server default (${globalEnabled ? "on" : "off"})`;
  const choose = (next: AutoUpdateChoice) => {
    if (!isAdmin || next === choice) return;
    save.mutate(next === "inherit" ? null : next === "on");
  };

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle>Automatic updates</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-5 pb-5">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{String(error)}</AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="agent-auto-update">Install new versions automatically</FieldLabel>
          <div className="flex items-center gap-3">
            <Select value={choice} disabled={save.isPending || !isAdmin} onValueChange={(value) => choose(value as AutoUpdateChoice)}>
              <SelectTrigger id="agent-auto-update" className="h-9 w-full sm:max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">{defaultLabel}</SelectItem>
                <SelectItem value="on">On</SelectItem>
                <SelectItem value="off">Off</SelectItem>
              </SelectContent>
            </Select>
            {save.isPending && <Spinner />}
          </div>
          {!isAdmin && <FieldDescription>Admin only.</FieldDescription>}
          {save.isSuccess && save.data.override && <FieldDescription>Applies when the device next connects.</FieldDescription>}
        </Field>
      </CardContent>
    </Card>
  );
}
