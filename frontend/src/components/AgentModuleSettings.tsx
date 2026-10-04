import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "../lib/api";
import { moduleLabel, stopRequestLabel, workerStopLabel, type DeviceModuleStatus } from "../lib/modulePermissions";
import { Alert, Badge, Button, Container, Header, SpaceBetween } from "./ui/console";

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
  return <Container header={<Header variant="h2" actions={<Button onClick={() => void refresh()}>Refresh permissions</Button>}>Device modules</Header>}>
    <SpaceBetween size="m">
      <p>Enable modules in this device’s local settings. Server controls can request a stop, including while the device is offline. Confirmation records revoked permission; running operations may still be finishing.</p>
      <p>Device-local approval is the standard mode. Authorized files, terminal, scripts, or desktop control can also change local settings; local approval does not prevent those tools from changing module permissions.</p>
      {error && <Alert type="error">{error}</Alert>}
      {message && <p role="status">{message}</p>}
      {!status && !error && <p role="status">Loading device permissions…</p>}
      {status && <>
        <p>{status.online ? "Device online" : "Device offline"}{status.reported_at ? ` · Last report ${new Date(status.reported_at).toLocaleString()}` : " · No device report yet"}.</p>
        {status.online && status.authorization_current === false && status.state && <Alert type="info">This report belongs to an earlier connection. Current permissions are unavailable until the device reports again.</Alert>}
        {!status.state && <Alert type="info">Connect an updated agent and authorize the modules in its local settings. Permission status is unavailable until the device reports it.</Alert>}
        {status.state?.modules.map(grant => <div key={grant.module} style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", paddingBlock: 8, borderBottom: "1px solid var(--line)" }}>
          <span style={{ flex: "1 1 160px" }}>{moduleLabel(grant.module)}</span>
          <Badge>{!grant.available ? "Unavailable" : grant.enabled ? (status.online && status.authorization_current === false ? "Previously authorized" : "Locally authorized") : "Authorization required on device"}</Badge>
          {canOperate && <Button disabled={!grant.available || !grant.enabled || busy !== null || status.pending.some(request => request.module === grant.module && request.expected_revision === grant.revision && ["queued", "pending", "sent"].includes(request.status))} loading={busy === grant.module} onClick={() => void stop(grant.module, grant.revision)}>Stop {moduleLabel(grant.module)}</Button>}
        </div>)}
        {status.pending.length > 0 && <div aria-label="Module stop requests">
          {status.pending.map(request => <div key={request.command_id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}><p style={{ flex: "1 1 220px" }}><strong>{moduleLabel(request.module)}</strong>: {stopRequestLabel(request.status)}{request.error ? ` · ${request.error}` : ""}{["disabled", "duplicate"].includes(request.status) ? ` · ${workerStopLabel(request)}` : ""}.</p>{canOperate && status.online && ["queued", "sent"].includes(request.status) && <Button disabled={busy !== null} loading={busy === request.module} onClick={() => void stop(request.module, request.expected_revision, request.command_id)}>Retry {moduleLabel(request.module)} stop</Button>}</div>)}
        </div>}
      </>}
    </SpaceBetween>
  </Container>;
}
