import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Ban, ChevronDown, CircleCheck, Circle, Clock, ShieldCheck } from "lucide-react";
import { api, errorText } from "@/api";
import type { DeviceModuleId, DeviceModuleGrant, DeviceModuleStatus } from "@/api/types";
import { moduleQueries } from "@/api/queries/modules";
import {
  MODULE_GROUPS,
  moduleGroup,
  moduleLabel,
  moduleStateKind,
  moduleStateText,
  stopRequestLabel,
  workerStopLabel,
  type ModuleGroupId,
  type ModuleStateKind,
} from "./modulePermissions";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent } from "@vantyr/ui/components/card";
import { Spinner } from "@vantyr/ui/components/spinner";
import { HelpTip } from "@/components/common/HelpTip";
import { RefreshButton } from "@/components/common/RefreshButton";
import { cn } from "@/lib/utils";

export function AgentModuleSettings({ agentId, canOperate }: { agentId: string; canOperate: boolean }) {
  return <ModuleSettings key={agentId} agentId={agentId} canOperate={canOperate} />;
}

const STOP_IN_FLIGHT = ["queued", "pending", "sent"];

function ModuleSettings({ agentId, canOperate }: { agentId: string; canOperate: boolean }) {
  // Polled every 5 s while the page is visible; a failed poll keeps the last report on screen.
  const statusQuery = useQuery({ ...moduleQueries.status(agentId), refetchInterval: 5000, refetchIntervalInBackground: false });
  const status = statusQuery.data ?? null;
  const refresh = () => statusQuery.refetch();
  // A stop failure shows until the next successful report, like the shared error state did.
  const [stopError, setStopError] = useState<{ message: string; reportAt: number } | null>(null);
  const error = currentModuleError(stopError, statusQuery.dataUpdatedAt, statusQuery.error);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Groups the person opened or closed by hand; the rest open when something in them is on.
  const [chosenOpen, setChosenOpen] = useState<Partial<Record<ModuleGroupId, boolean>>>({});
  const messageRef = useRef<HTMLParagraphElement>(null);
  const scope = useRef(0);
  useEffect(() => {
    const generation = ++scope.current;
    return () => { scope.current = generation + 1; };
  }, []);
  // A stopped module loses its Stop button, so keyboard focus moves to the outcome rather than to the page.
  useEffect(() => { if (message) messageRef.current?.focus(); }, [message]);
  const stop = async (module: DeviceModuleId, revision: number, commandId: string = crypto.randomUUID()) => {
    const generation = scope.current;
    setBusy(module); setMessage(null); setStopError(null);
    setChosenOpen(open => ({ ...open, [moduleGroup(module)]: true }));
    try {
      const request = await api.disableAgentModule(agentId, { module, expected_revision: revision, command_id: commandId });
      if (generation !== scope.current) return;
      setMessage(`${moduleLabel(module)}: ${stopRequestLabel(request.status)}.`);
      await refresh();
    } catch (e) { if (generation === scope.current) setStopError({ message: errorText(e), reportAt: statusQuery.dataUpdatedAt }); }
    finally { if (generation === scope.current) setBusy(null); }
  };
  const toggleGroup = (group: ModuleGroupId, open: boolean) => setChosenOpen(chosen => ({ ...chosen, [group]: open }));

  return <Card className="gap-0 py-0">
    <CardContent className="flex flex-col gap-5 p-5 text-sm">
      <ModuleHeader status={status} onRefresh={() => void refresh()} refreshing={statusQuery.isFetching} />
      <p className="flex items-start gap-2 text-muted-foreground">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>Only the device can turn modules on, in its Vantyr app. From here you can only stop them, even while it is offline.</span>
      </p>
      {error && <Alert variant="destructive"><AlertDescription className="flex flex-wrap items-center justify-between gap-2"><span>{error}</span><Button variant="outline" size="sm" onClick={() => void refresh()}>Try again</Button></AlertDescription></Alert>}
      {message && <p ref={messageRef} tabIndex={-1} role="status" className="text-success outline-none">{message}</p>}
      {!status && !error && <p role="status" className="flex items-center gap-2 text-muted-foreground"><Spinner /> Loading…</p>}
      {status && <ModuleReport status={status} canOperate={canOperate} busy={busy} chosenOpen={chosenOpen} onToggleGroup={toggleGroup} onStop={stop} />}
    </CardContent>
  </Card>;
}

function ModuleHeader({ status, onRefresh, refreshing }: { status: DeviceModuleStatus | null; onRefresh: () => void; refreshing: boolean }) {
  const modules = status?.state?.modules ?? null;
  const on = modules?.filter(grant => grant.available && grant.enabled).length ?? 0;
  const unavailable = modules?.filter(grant => !grant.available).length ?? 0;
  const reportNote = !status?.online ? " at last report" : status.authorization_current === false ? " at earlier report" : "";
  const summary = modules ? `${on} of ${modules.length - unavailable} modules on${reportNote}` : "Modules";
  return <div className="flex items-start justify-between gap-3">
    <div className="flex min-w-0 flex-col gap-0.5">
      <h3 className="text-base font-medium">{summary}</h3>
      {status && <ReportLine status={status} />}
    </div>
    <div className="flex shrink-0 items-center gap-1">
      <HelpTip label="What module states mean">
        <span className="block"><strong>On</strong>: authorized on the device. Runs when needed.</span>
        <span className="mt-1 block"><strong>Off</strong>: turned off. Only someone at the device can turn it back on.</span>
        <span className="mt-1 block"><strong>Unavailable</strong>: this device or app version does not support it.</span>
      </HelpTip>
      <RefreshButton onClick={onRefresh} loading={refreshing} />
    </div>
  </div>;
}

function ReportLine({ status }: { status: DeviceModuleStatus }) {
  const when = status.reported_at ? new Date(status.reported_at).toLocaleString() : null;
  if (!when) return <p className="text-xs text-warning">No report from this device yet</p>;
  return <p className={cn("text-xs", status.online ? "text-muted-foreground" : "text-warning")}>
    {status.online ? `Online · reported ${when}` : `Offline · last report ${when}`}
  </p>;
}

function ModuleReport({ status, canOperate, busy, chosenOpen, onToggleGroup, onStop }: {
  status: DeviceModuleStatus; canOperate: boolean; busy: string | null;
  chosenOpen: Partial<Record<ModuleGroupId, boolean>>;
  onToggleGroup: (group: ModuleGroupId, open: boolean) => void;
  onStop: (module: DeviceModuleId, revision: number, commandId?: string) => Promise<void>;
}) {
  const modules = status.state?.modules ?? null;
  return <>
    {status.online && status.authorization_current === false && status.state && <Alert><AlertDescription>Report is from an earlier connection. Values may be out of date.</AlertDescription></Alert>}
    {!modules && <Alert><AlertDescription>Permission status unavailable. This device has not reported its modules. Authorize modules on the device.</AlertDescription></Alert>}
    {status.pending.length > 0 && <StopRequests status={status} canOperate={canOperate} busy={busy} onStop={onStop} />}
    {modules && <div className="flex flex-col gap-3">
      {MODULE_GROUPS.map(group => {
        const grants = modules.filter(grant => moduleGroup(grant.module) === group.id);
        if (grants.length === 0) return null;
        return <ModuleGroup key={group.id} id={group.id} label={group.label} grants={grants} status={status} canOperate={canOperate} busy={busy}
          chosen={chosenOpen[group.id]} onToggle={onToggleGroup} onStop={onStop} />;
      })}
    </div>}
  </>;
}

function stopInFlight(status: DeviceModuleStatus, grant: DeviceModuleGrant) {
  return status.pending.some(request => request.module === grant.module && request.expected_revision === grant.revision && STOP_IN_FLIGHT.includes(request.status));
}

function ModuleGroup({ id, label, grants, status, canOperate, busy, chosen, onToggle, onStop }: {
  id: ModuleGroupId; label: string; grants: DeviceModuleGrant[]; status: DeviceModuleStatus; canOperate: boolean; busy: string | null;
  chosen: boolean | undefined; onToggle: (group: ModuleGroupId, open: boolean) => void;
  onStop: (module: DeviceModuleId, revision: number) => Promise<void>;
}) {
  const on = grants.filter(grant => grant.available && grant.enabled).length;
  const open = chosen ?? on > 0;
  return <section className="overflow-hidden rounded-lg border border-foreground/[0.08]">
    <h4>
      <button type="button" aria-expanded={open} aria-controls={`modules-${id}`} onClick={() => onToggle(id, !open)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left font-medium outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset">
        <ChevronDown aria-hidden="true" className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className={cn("shrink-0 text-xs font-normal tabular-nums", on > 0 ? "text-success" : "text-muted-foreground")}>{on} of {grants.length} on</span>
      </button>
    </h4>
    {open && <ul id={`modules-${id}`} aria-label={`${label} modules`} className="border-t border-foreground/[0.06]">
      {grants.map(grant => <ModuleGrantRow key={grant.module} grant={grant} status={status} canOperate={canOperate} busy={busy} onStop={onStop} />)}
    </ul>}
  </section>;
}

const STATE_ICON: Record<ModuleStateKind, { Icon: typeof Circle; tone: string }> = {
  on: { Icon: CircleCheck, tone: "text-success" },
  stopping: { Icon: Clock, tone: "text-warning" },
  off: { Icon: Circle, tone: "text-muted-foreground" },
  unavailable: { Icon: Ban, tone: "text-muted-foreground/60" },
};

function ModuleGrantRow({ grant, status, canOperate, busy, onStop }: {
  grant: DeviceModuleGrant; status: DeviceModuleStatus; canOperate: boolean; busy: string | null;
  onStop: (module: DeviceModuleId, revision: number) => Promise<void>;
}) {
  const stopPending = stopInFlight(status, grant);
  const kind = moduleStateKind(grant, stopPending);
  const text = moduleStateText(kind, { online: status.online, authorizationCurrent: status.authorization_current !== false });
  const { Icon, tone } = STATE_ICON[kind];
  // Only a module the device reported as on can be stopped; there is deliberately no way to turn one on from here.
  const stoppable = canOperate && (kind === "on" || kind === "stopping");
  return <li className="flex min-h-11 items-center gap-3 border-b border-foreground/[0.06] px-3 py-2 last:border-b-0">
    <Icon aria-hidden="true" className={cn("size-4 shrink-0", tone)} />
    <span className={cn("min-w-0 flex-1 truncate", kind === "unavailable" && "text-muted-foreground")}>{moduleLabel(grant.module)}</span>
    <span className={cn("shrink-0 text-sm", kind === "on" ? "text-success" : kind === "stopping" ? "text-warning" : "text-muted-foreground")}>{text}</span>
    {stoppable && <Button variant="outline" size="sm" className="pointer-coarse:h-9" aria-label={`Stop ${moduleLabel(grant.module)}`} disabled={busy !== null || stopPending} onClick={() => void onStop(grant.module, grant.revision)}><span>Stop</span>{busy === grant.module && <Spinner />}</Button>}
  </li>;
}

function StopRequests({ status, canOperate, busy, onStop }: {
  status: DeviceModuleStatus; canOperate: boolean; busy: string | null;
  onStop: (module: DeviceModuleId, revision: number, commandId?: string) => Promise<void>;
}) {
  return <section aria-label="Module stop requests" className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3">
    <h4 className="font-medium">Stop requests</h4>
    {status.pending.map(request => <div key={request.command_id} className="flex flex-wrap items-center gap-2">
      <p className="flex-1 basis-55"><strong>{moduleLabel(request.module)}</strong>: {stopRequestLabel(request.status)}{request.error ? ` · ${request.error}` : ""}{["disabled", "duplicate"].includes(request.status) ? ` · ${workerStopLabel(request)}` : ""}.</p>
      {canOperate && status.online && ["queued", "sent"].includes(request.status) && <Button variant="outline" size="sm" className="pointer-coarse:h-9" disabled={busy !== null} onClick={() => void onStop(request.module, request.expected_revision, request.command_id)}><span>Retry {moduleLabel(request.module)} stop</span>{busy === request.module && <Spinner />}</Button>}
    </div>)}
  </section>;
}

function currentModuleError(stopError: { message: string; reportAt: number } | null, updatedAt: number, queryError: unknown) {
  if (stopError && stopError.reportAt >= updatedAt) return stopError.message;
  return queryError ? errorText(queryError) : null;
}
