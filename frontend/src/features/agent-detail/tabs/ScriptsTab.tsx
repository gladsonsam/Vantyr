import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, CircleX, Info, Play, TriangleAlert, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { Textarea } from "@vantyr/ui/components/textarea";
import { Spinner } from "@vantyr/ui/components/spinner";
import { api, errorText } from "@/api";
import { settingsQueries } from "@/api/queries/settings";
import type { AgentInfo, DashboardRole } from "@/api/types";
import { CopyTextButton } from "@/components/common/CopyTextButton";
import {
  capabilityAvailable,
  platformShellOptions,
} from "@/features/agent-detail/lib/agentCapabilities";
import { describeScriptResult, type ScriptOutcome } from "@/features/agent-detail/lib/scriptResult";
import { CapabilityNotice } from "@/features/agent-detail/components/CapabilityNotice";
import { cn } from "@/lib/utils";

interface ScriptsTabProps {
  agentId: string;
  agentInfo?: AgentInfo | null;
  dashboardRole?: DashboardRole | null;
}

const TIMEOUT_SECS = 120;

/** Shown as a placeholder only: a pre-filled box would run on a single click. */
function exampleScriptForShell(shell: string): string {
  if (shell === "sh" || shell === "bash") return "uname -a\nuptime\nfree -h";
  return "Get-ComputerInfo | Select-Object WindowsProductName, OsVersion | Format-List";
}

export function ScriptsTab({ agentId, agentInfo, dashboardRole = null }: ScriptsTabProps) {
  const [chosenShell, setChosenShell] = useState("powershell");
  const [script, setScript] = useState("");
  const capabilitiesQuery = useQuery(settingsQueries.capabilities());
  // `null` while unknown; a failed check counts as "not allowed".
  const remoteOk = capabilitiesQuery.isError
    ? false
    : (capabilitiesQuery.data?.remote_script ?? null);
  const queryClient = useQueryClient();
  const runScript = useMutation({
    mutationFn: (body: { shell: string; script: string; timeout_secs: number }) =>
      api.runAgentScript(agentId, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
  });
  const running = runScript.isPending;
  const outcome = useMemo(
    () => (runScript.data ? describeScriptResult(runScript.data) : null),
    [runScript.data],
  );
  const scriptAvailable = capabilityAvailable(agentInfo, "script_execution");
  const shellOptions = useMemo(() => platformShellOptions(agentInfo), [agentInfo]);

  // A shell this agent lacks (a Linux device after PowerShell was picked) falls back to its first option.
  const shell = shellOptions.find((o) => o.value === chosenShell) ?? shellOptions[0];

  const blockedByRole = dashboardRole === "viewer";
  const remoteAllowed = remoteOk === true;
  const scriptControlsDisabled = !remoteAllowed || blockedByRole || running;

  if (!scriptAvailable) {
    return (
      <CapabilityNotice
        info={agentInfo}
        capability="script_execution"
        title="Scripts unavailable"
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ScriptAvailabilityNotice viewer={blockedByRole} remoteOk={remoteOk} />

      <section className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card/10 p-3 sm:p-4">
        <div className="flex items-center gap-3">
          <label htmlFor="scripts-shell" className="text-sm text-muted-foreground">
            Shell
          </label>
          <Select
            value={shell.value}
            disabled={scriptControlsDisabled}
            onValueChange={(next) => {
              if (next) setChosenShell(next);
            }}
          >
            <SelectTrigger id="scripts-shell" className="min-w-0 flex-1 sm:w-64 sm:flex-none">
              <SelectValue placeholder="Select a shell" />
            </SelectTrigger>
            <SelectContent>
              {shellOptions.map((o) => (
                <SelectItem key={String(o.value)} value={String(o.value)}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Textarea
          aria-label="Script"
          rows={10}
          className="min-h-40 font-sans text-[13px]"
          value={script}
          placeholder={exampleScriptForShell(shell.value)}
          onChange={(e) => setScript(e.target.value)}
          disabled={scriptControlsDisabled}
          spellCheck={false}
        />

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            disabled={scriptControlsDisabled || !script.trim()}
            onClick={() =>
              runScript.mutate({ shell: shell.value, script, timeout_secs: TIMEOUT_SECS })
            }
          >
            {running ? <Spinner /> : <Play />} {running ? "Running…" : "Run script"}
          </Button>
          <Button
            variant="ghost"
            disabled={scriptControlsDisabled || !script}
            onClick={() => setScript("")}
          >
            Clear
          </Button>
          <p className="min-w-0 flex-1 basis-56 text-xs text-muted-foreground">
            Runs right away on this device and is recorded in the audit log. Stops after{" "}
            {TIMEOUT_SECS / 60} minutes.
          </p>
        </div>
      </section>

      {running && (
        <p role="status" className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
          <Spinner /> Waiting for the device to reply. This can take up to {TIMEOUT_SECS / 60}{" "}
          minutes.
        </p>
      )}

      {runScript.error && (
        <div
          role="alert"
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm break-words text-destructive"
        >
          The script didn’t run. {errorText(runScript.error)}
        </div>
      )}

      {outcome && !running && (
        <ScriptResultPanel
          outcome={outcome}
          ranAt={runScript.submittedAt}
          onDismiss={() => runScript.reset()}
        />
      )}
    </div>
  );
}

function ScriptResultPanel({
  outcome,
  ranAt,
  onDismiss,
}: {
  outcome: ScriptOutcome;
  ranAt: number;
  onDismiss: () => void;
}) {
  const Icon =
    outcome.tone === "ok" ? CircleCheck : outcome.tone === "failed" ? CircleX : CircleAlert;
  const output = [outcome.stdout, outcome.stderr].filter(Boolean).join("\n");
  const empty = !outcome.stdout && !outcome.stderr && !outcome.error;
  return (
    <section
      aria-label="Script result"
      className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card/10 p-3 sm:p-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p
          role="status"
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 text-sm font-medium",
            outcome.tone === "ok"
              ? "text-success"
              : outcome.tone === "failed"
                ? "text-destructive"
                : "text-warning",
          )}
        >
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{outcome.headline}</span>
          <span className="text-xs font-normal text-muted-foreground tabular-nums">
            {new Date(ranAt).toLocaleTimeString()}
          </span>
        </p>
        <CopyTextButton text={output || outcome.error || ""} label="Copy output" disabled={empty} />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Clear result"
          title="Clear result"
          className="pointer-coarse:size-9"
          onClick={onDismiss}
        >
          <X />
        </Button>
      </div>
      {outcome.error && (
        <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm break-words text-warning">
          {outcome.error}
        </p>
      )}
      {empty && <p className="text-sm text-muted-foreground">The script produced no output.</p>}
      <OutputBlock label="Output" text={outcome.stdout} />
      <OutputBlock label="Errors" text={outcome.stderr} tone="error" />
    </section>
  );
}

function OutputBlock({ label, text, tone }: { label: string; text: string; tone?: "error" }) {
  if (!text) return null;
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs text-muted-foreground">{label}</h3>
      <pre
        tabIndex={0}
        aria-label={label}
        className={cn(
          "max-h-80 overflow-auto rounded-lg bg-muted/50 p-3 font-sans text-xs whitespace-pre-wrap break-words focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
          tone === "error" && "text-destructive",
        )}
      >
        {text}
      </pre>
    </div>
  );
}

function ScriptAvailabilityNotice({
  viewer,
  remoteOk,
}: {
  viewer: boolean;
  remoteOk: boolean | null;
}) {
  return (
    <>
      {viewer && (
        <Alert>
          <Info />
          <AlertTitle>Operators only.</AlertTitle>
        </Alert>
      )}

      {remoteOk === false && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>Remote scripting is off</AlertTitle>
          <AlertDescription>
            Set <code>ALLOW_REMOTE_SCRIPT_EXECUTION=true</code> on the server and restart it.
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}
