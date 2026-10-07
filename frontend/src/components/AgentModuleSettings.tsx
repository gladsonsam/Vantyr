import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, errorText } from "@/api";
import { moduleLabel, stopRequestLabel, workerStopLabel, type DeviceModuleStatus } from "@/lib/modulePermissions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

export function AgentModuleSettings({ agentId, canOperate }: { agentId: string; canOperate: boolean }) {
  return <ModuleSettings key={agentId} agentId={agentId} canOperate={canOperate} />;
}
function ModuleSettings({ agentId, canOperate }: { agentId: string; canOperate: boolean }) {
  const [status, setStatus] = useState<DeviceModuleStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const scope = useRef(0);
  const fetchVersion = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++fetchVersion.current, generation = scope.current;
    try {
      const result = await api.agentModules(agentId);
      if (generation === scope.current && request === fetchVersion.current) { setStatus(result); setError(null); }
    } catch (e) {
      if (generation === scope.current && request === fetchVersion.current) setError(errorText(e));
    }
  }, [agentId]);
  useEffect(() => {
    const generation = ++scope.current;
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => { scope.current = generation + 1; window.clearInterval(timer); };
  }, [refresh]);
  const stop = async (module: string, revision: number, commandId: string = crypto.randomUUID()) => {
    const generation = scope.current;
    setBusy(module); setMessage(null); setError(null);
    try {
      const request = await api.disableAgentModule(agentId, { module, expected_revision: revision, command_id: commandId });
      if (generation !== scope.current) return;
      setMessage(`${moduleLabel(module)}: ${stopRequestLabel(request.status)}.`);
      await refresh();
    } catch (e) { if (generation === scope.current) setError(errorText(e)); }
    finally { if (generation === scope.current) setBusy(null); }
  };
  return <Card className="gap-0 py-0">
    <CardHeader className="px-5 pt-5 pb-2">
      <CardTitle>Device modules</CardTitle>
      <CardAction>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          <RefreshCw /><span>Refresh</span>
        </Button>
      </CardAction>
    </CardHeader>
    <CardContent className="flex flex-col gap-4 px-5 pb-5 text-sm">
      <p className="text-muted-foreground">Enable on the device; stop from here, even offline.</p>
      <p className="text-muted-foreground">Remote tools can also change local approvals.</p>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {message && <p role="status" className="text-success">{message}</p>}
      {!status && !error && <p role="status" className="flex items-center gap-2 text-muted-foreground"><Spinner /> Loading…</p>}
      {status && <>
        <p className="text-muted-foreground">{status.online ? "Online" : "Offline"}{status.reported_at ? ` · Reported ${new Date(status.reported_at).toLocaleString()}` : " · No report yet"}</p>
        {status.online && status.authorization_current === false && status.state && <Alert><AlertDescription>Report is from an earlier connection.</AlertDescription></Alert>}
        {!status.state && <Alert><AlertDescription>Permission status unavailable. Authorize modules on the device.</AlertDescription></Alert>}
        {status.state?.modules.map(grant => {
          const stopPending = status.pending.some(request => request.module === grant.module && request.expected_revision === grant.revision && ["queued", "pending", "sent"].includes(request.status));
          const stateText = !grant.available
            ? "Unavailable"
            : grant.enabled
              ? (status.online && status.authorization_current === false ? "Previously authorized" : "Locally authorized")
              : "Not authorized";
          const stateClass = !grant.available
            ? "text-muted-foreground"
            : grant.enabled ? "text-success" : "text-warning";
          return (
            <div key={grant.module} className="flex flex-wrap items-center gap-3 border-b border-foreground/[0.06] py-3 last:border-b-0">
              <span className="flex-1 basis-40 font-medium">{moduleLabel(grant.module)}</span>
              <span className={`text-sm font-medium ${stateClass}`}>{stateText}</span>
              {canOperate && <Button variant="outline" size="sm" aria-label={`Stop ${moduleLabel(grant.module)}`} disabled={!grant.available || !grant.enabled || busy !== null || stopPending} onClick={() => void stop(grant.module, grant.revision)}><span>Stop</span>{busy === grant.module && <Spinner />}</Button>}
            </div>
          );
        })}
        {status.pending.length > 0 && <div aria-label="Module stop requests" className="flex flex-col gap-3">
          {status.pending.map(request => <div key={request.command_id} className="flex flex-wrap items-center gap-2"><p className="flex-1 basis-55"><strong>{moduleLabel(request.module)}</strong>: {stopRequestLabel(request.status)}{request.error ? ` · ${request.error}` : ""}{["disabled", "duplicate"].includes(request.status) ? ` · ${workerStopLabel(request)}` : ""}.</p>{canOperate && status.online && ["queued", "sent"].includes(request.status) && <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void stop(request.module, request.expected_revision, request.command_id)}><span>Retry {moduleLabel(request.module)} stop</span>{busy === request.module && <Spinner />}</Button>}</div>)}
        </div>}
      </>}
    </CardContent>
  </Card>;
}
