import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleHelp, Clock, CloudDownload } from "lucide-react";
import { api, errorText } from "@/api";
import { settingsKeys, settingsQueries } from "@/api/queries/settings";
import { useServerVersionPayload } from "@/api/serverVersionStore";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent } from "@vantyr/ui/components/card";
import { Spinner } from "@vantyr/ui/components/spinner";
import { ToggleGroup, ToggleGroupItem } from "@vantyr/ui/components/toggle-group";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import { cn } from "@/lib/utils";
import { normalizeVersion } from "@/features/fleet/lib/fleetUtils";
import {
  autoUpdateChoice,
  autoUpdateEffective,
  updateRequestOutcome,
  versionLabel,
  versionState,
  type AutoUpdateChoice,
  type UpdateRequest,
  type VersionState,
} from "./updatePolicy";

const VERSION_STATUS: Record<VersionState, { text: string; Icon: typeof Clock; tone: string }> = {
  available: { text: "A newer version is available", Icon: CloudDownload, tone: "text-warning" },
  current: { text: "Up to date", Icon: CircleCheck, tone: "text-success" },
  "latest-unknown": { text: "The latest version is unknown", Icon: CircleHelp, tone: "text-muted-foreground" },
  "installed-unknown": { text: "This device has not reported its version", Icon: CircleHelp, tone: "text-muted-foreground" },
};

function timeOf(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

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
  const state = versionState(agentVersion, latestAgentVersion);
  const queryClient = useQueryClient();
  const [request, setRequest] = useState<UpdateRequest | null>(null);
  const updateNow = useMutation({
    mutationFn: () => api.agentUpdateNow(agentId),
    // Only the command was sent. Whether the update happened is read from the version the device reports afterwards.
    onSuccess: () => {
      setRequest({ at: Date.now(), from: normalizeVersion(agentVersion) });
      return queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
  const outcome = updateRequestOutcome(request, agentVersion);
  const { text, Icon, tone } = VERSION_STATUS[state];
  const waiting = outcome?.kind === "waiting";

  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex flex-col gap-4 p-5 text-sm">
        <dl className="flex flex-wrap gap-x-10 gap-y-3">
          <div>
            <dt className="text-muted-foreground">Installed</dt>
            <dd className="text-lg font-semibold tabular-nums">{versionLabel(agentVersion)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Latest</dt>
            <dd className="text-lg font-semibold tabular-nums">{versionLabel(latestAgentVersion)}</dd>
          </div>
        </dl>
        <p className={cn("flex items-center gap-2", tone)}>
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          <span>{text}</span>
        </p>

        {updateNow.error && (
          <Alert variant="destructive">
            <AlertDescription>{errorText(updateNow.error)}</AlertDescription>
          </Alert>
        )}
        {outcome?.kind === "changed" && (
          <p role="status" className="text-success">
            The device now reports v{outcome.to} (was v{outcome.from}).
          </p>
        )}
        {waiting && (
          <p role="status" className="flex items-start gap-2 text-muted-foreground">
            <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>Update requested at {timeOf(outcome.at)}. It is not finished until the device restarts and reports a new version.</span>
          </p>
        )}

        {state === "available" && isAdmin && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button disabled={updateNow.isPending || !agentOnline} onClick={() => updateNow.mutate()}>
              {updateNow.isPending && <Spinner />} {waiting ? "Request again" : "Update now"}
            </Button>
            {!agentOnline && <span className="text-muted-foreground">Available when the device is online.</span>}
          </div>
        )}
        {state === "available" && !isAdmin && <p className="text-muted-foreground">Only admins can start an update.</p>}
      </CardContent>
    </Card>
  );
}

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

  if (autoUpdQuery.isPending) return null;
  if (!autoUpdQuery.data) {
    return (
      <LoadFailedCard
        message={autoUpdQuery.error ? errorText(autoUpdQuery.error) : "Automatic update settings are unavailable."}
        onRetry={() => void autoUpdQuery.refetch()}
      />
    );
  }

  const choice = autoUpdateChoice(override);
  const defaultLabel = globalEnabled == null ? "Server default" : `Server default (${globalEnabled ? "on" : "off"})`;
  const choose = (next: AutoUpdateChoice) => {
    if (!isAdmin || next === choice) return;
    save.mutate(next === "inherit" ? null : next === "on");
  };
  const error = save.error ?? autoUpdQuery.error;

  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex flex-col gap-3 p-5 text-sm">
        <h3 className="text-base font-medium">Automatic updates</h3>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{errorText(error)}</AlertDescription>
          </Alert>
        )}
        <div className="flex items-center gap-3">
          <ToggleGroup
            size="sm"
            spacing={0}
            className="max-w-full flex-wrap rounded-lg bg-muted/70 p-0.5"
            aria-label="Install new versions automatically on this device"
            value={[choice]}
            disabled={save.isPending || !isAdmin}
            onValueChange={(value) => {
              const next = value[0] as AutoUpdateChoice | undefined;
              if (next) choose(next);
            }}
          >
            <ToggleGroupItem value="inherit" className="rounded-md! px-2.5 aria-pressed:bg-background pointer-coarse:h-9">
              {defaultLabel}
            </ToggleGroupItem>
            <ToggleGroupItem value="on" className="rounded-md! px-2.5 aria-pressed:bg-background pointer-coarse:h-9">
              On
            </ToggleGroupItem>
            <ToggleGroupItem value="off" className="rounded-md! px-2.5 aria-pressed:bg-background pointer-coarse:h-9">
              Off
            </ToggleGroupItem>
          </ToggleGroup>
          {save.isPending && <Spinner />}
        </div>
        <p className="text-muted-foreground">{autoUpdateEffective(globalEnabled, override)}</p>
        {save.isSuccess && !error && (
          <p role="status" className="text-success">
            Saved. A connected device is sent it now; others get it when they next connect.
          </p>
        )}
        {!isAdmin && <p className="text-muted-foreground">Only admins can change this.</p>}
      </CardContent>
    </Card>
  );
}
