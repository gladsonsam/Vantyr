import { useEffect, useMemo, useState } from "react";
import { Info, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/api";
import type { AgentInfo, DashboardRole } from "@/api/types";
import { capabilityAvailable, platformShellOptions } from "@/lib/agentCapabilities";
import { CapabilityNotice } from "@/components/common/CapabilityNotice";

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

  if (!scriptAvailable) {
    return <CapabilityNotice info={agentInfo} capability="script_execution" title="Scripts unavailable" />;
  }

  return (
    <div className="flex flex-col gap-6">
      {dashboardRole === "viewer" && (
        <Alert>
          <Info />
          <AlertTitle>Operators only.</AlertTitle>
        </Alert>
      )}

      {remoteOk === false && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>Remote scripting disabled</AlertTitle>
          <AlertDescription>
            Set <code>ALLOW_REMOTE_SCRIPT_EXECUTION=true</code> on the server and restart.
          </AlertDescription>
        </Alert>
      )}

      {err && (
        <Alert variant="destructive">
          <AlertDescription>{err}</AlertDescription>
        </Alert>
      )}

      <Field>
        <FieldLabel htmlFor="scripts-shell">Shell</FieldLabel>
        <Select
          value={shell.value}
          disabled={scriptControlsDisabled}
          onValueChange={(next) => {
            const option = shellOptions.find((o) => String(o.value) === next);
            if (option) {
              setShell({ label: option.label ?? String(option.value), value: String(option.value) });
              setScript(defaultScriptForShell(String(option.value)));
            }
          }}
        >
          <SelectTrigger id="scripts-shell" className="w-full">
            <SelectValue placeholder="Select a shell" />
          </SelectTrigger>
          <SelectContent>
            {shellOptions.map((o) => (
              <SelectItem key={String(o.value)} value={String(o.value)}>
                {o.label ?? String(o.value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field>
        <FieldLabel htmlFor="scripts-body">Script</FieldLabel>
        <Textarea
          id="scripts-body"
          rows={14}
          className="font-mono text-[13px]"
          value={script}
          onChange={(e) => setScript(e.target.value)}
          disabled={scriptControlsDisabled}
          spellCheck={false}
        />
      </Field>

      <div>
        <Button
          disabled={!remoteAllowed || blockedByRole || running}
          onClick={() => void run()}
        >
          {running && <Spinner />} Run
        </Button>
      </div>

      {result && (
        <div className="flex flex-col gap-2">
          <h3 className="font-heading text-sm font-semibold">Result</h3>
          <pre className="overflow-x-auto rounded-xl bg-muted/50 p-4 font-mono text-xs whitespace-pre-wrap">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
