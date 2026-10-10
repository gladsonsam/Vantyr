import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Info, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Field, FieldLabel } from "@vantyr/ui/components/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { Textarea } from "@vantyr/ui/components/textarea";
import { Spinner } from "@vantyr/ui/components/spinner";
import { api } from "@/api";
import { settingsQueries } from "@/api/queries/settings";
import type { AgentInfo, DashboardRole } from "@/api/types";
import { capabilityAvailable, platformShellOptions } from "@/features/agent-detail/lib/agentCapabilities";
import { CapabilityNotice } from "@/features/agent-detail/components/CapabilityNotice";

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
  const [shell, setShell] = useState<{ label: string; value: string }>({
    label: "PowerShell",
    value: "powershell",
  });
  const [script, setScript] = useState(defaultScriptForShell("powershell"));
  const capabilitiesQuery = useQuery(settingsQueries.capabilities());
  // `null` while unknown; a failed check counts as "not allowed".
  const remoteOk = capabilitiesQuery.isError ? false : capabilitiesQuery.data?.remote_script ?? null;
  const runScript = useMutation({
    mutationFn: (body: { shell: string; script: string; timeout_secs: number }) => api.runAgentScript(agentId, body),
  });
  const running = runScript.isPending;
  const result = runScript.data ?? null;
  const err = runScript.error ? String(runScript.error) : null;
  const scriptAvailable = capabilityAvailable(agentInfo, "script_execution");
  const shellOptions = useMemo(() => platformShellOptions(agentInfo), [agentInfo]);

  // The platform shells change with the agent; a shell the new agent lacks
  // falls back to its first option, like the old sync effect did.
  const [prevShellOptions, setPrevShellOptions] = useState(shellOptions);
  if (prevShellOptions !== shellOptions) {
    setPrevShellOptions(shellOptions);
    if (!shellOptions.some((option) => option.value === shell.value)) {
      const next = shellOptions[0];
      setShell(next);
      setScript(defaultScriptForShell(next.value));
    }
  }

  const run = () => {
    runScript.mutate({
      shell: shell.value,
      script,
      timeout_secs: 120,
    });
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
