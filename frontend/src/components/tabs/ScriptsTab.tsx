import { Alert, Button, FormField, Header, Select, SpaceBetween } from "../ui/console";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import type { AgentInfo, DashboardRole } from "../../lib/types";
import { capabilityAvailable, platformShellOptions } from "../../lib/agentCapabilities";
import { CapabilityNotice } from "../common/CapabilityNotice";

interface ScriptsTabProps {
  agentId: string;
  agentInfo?: AgentInfo | null;
  dashboardRole?: DashboardRole | null;
}

function defaultScriptForShell(shell: string): string {
  if (shell === "sh" || shell === "bash") return "uname -a\nuptime\nfree -h";
  return "Get-ComputerInfo | Select-Object WindowsProductName, OsVersion | Format-List";
}

export function ScriptsTab({ agentId, agentInfo, dashboardRole = null }: ScriptsTabProps) {
  const [remoteOk, setRemoteOk] = useState<boolean | null>(null);
  const [shell, setShell] = useState<{ label: string; value: string }>({
    label: "PowerShell",
    value: "powershell",
  });
  const [script, setScript] = useState(defaultScriptForShell("powershell"));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const scriptAvailable = capabilityAvailable(agentInfo, "script_execution");
  const shellOptions = useMemo(() => platformShellOptions(agentInfo), [agentInfo]);

  useEffect(() => {
    if (shellOptions.some((option) => option.value === shell.value)) return;
    const next = shellOptions[0];
    setShell(next);
    setScript(defaultScriptForShell(next.value));
  }, [shell.value, shellOptions]);

  useEffect(() => {
    api
      .capabilities()
      .then((c) => setRemoteOk(c.remote_script))
      .catch(() => setRemoteOk(false));
  }, []);

  const run = async () => {
    setErr(null);
    setResult(null);
    setRunning(true);
    try {
      const out = await api.runAgentScript(agentId, {
        shell: shell.value,
        script,
        timeout_secs: 120,
      });
      setResult(out);
    } catch (e) {
      setErr(String(e));
    } finally {
      setRunning(false);
    }
  };

  const blockedByRole = dashboardRole === "viewer";
  const remoteAllowed = remoteOk === true;
  const scriptControlsDisabled = !remoteAllowed || blockedByRole || running || !scriptAvailable;

  const headerDescription =
    remoteOk === false
      ? "The Vantyr server was not started with remote script execution enabled. Set environment variable ALLOW_REMOTE_SCRIPT_EXECUTION=true on the server and restart it to use this tab. When enabled, this runs PowerShell or cmd on this machine over the agent WebSocket — equivalent to arbitrary code execution: use only on trusted networks."
      : "Runs an agent-supported shell on this machine over the agent WebSocket.";

  if (!scriptAvailable) {
    return <CapabilityNotice info={agentInfo} capability="script_execution" title="Remote script unavailable" />;
  }

  return (
    <SpaceBetween size="l">
      <Header variant="h2" description={headerDescription}>
        Remote script
      </Header>

      {dashboardRole === "viewer" && (
        <Alert type="info" header="Operator role required">
          Your account is a viewer. Ask an administrator to grant the <strong>operator</strong> role if you need to run
          remote scripts (operators and admins may run scripts when the server enables this feature).
        </Alert>
      )}

      {remoteOk === false && (
        <Alert type="warning" header="Remote scripting disabled">
          Set <code>ALLOW_REMOTE_SCRIPT_EXECUTION=true</code> on the Vantyr server, then restart the server.
        </Alert>
      )}

      {err && (
        <Alert type="error" dismissible onDismiss={() => setErr(null)}>
          {err}
        </Alert>
      )}

      <FormField label="Shell">
        <Select
          selectedOption={shell}
          disabled={scriptControlsDisabled}
          onChange={({ detail }) => {
            const o = detail.selectedOption;
            if (o?.value != null) {
              setShell({ label: o.label ?? String(o.value), value: String(o.value) });
              setScript(defaultScriptForShell(String(o.value)));
            }
          }}
          options={shellOptions}
        />
      </FormField>

      <FormField
        label="Script"
        description={
          shell.value === "powershell"
            ? "PowerShell script body (saved to a temp .ps1 file)."
            : shell.value === "cmd"
              ? "For cmd, long or multi-line scripts are written to a temp .bat file."
              : "Shell script body executed with the selected Linux shell."
        }
      >
        <textarea
          className="sx-textarea"
          rows={14}
          style={{ width: "100%", fontFamily: "monospace", fontSize: "13px", padding: "8px" }}
          value={script}
          onChange={(e) => setScript(e.target.value)}
          disabled={scriptControlsDisabled}
          spellCheck={false}
        />
      </FormField>

      <Button
        variant="primary"
        loading={running}
        disabled={!remoteAllowed || blockedByRole}
        onClick={() => void run()}
      >
        Run on this agent
      </Button>

      {result && (
        <SpaceBetween size="s">
          <Header variant="h3">Result</Header>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: "12px", margin: 0 }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        </SpaceBetween>
      )}
    </SpaceBetween>
  );
}
