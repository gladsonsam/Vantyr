import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vantyr/ui/components/dialog";
import { Field, FieldLabel } from "@vantyr/ui/components/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@vantyr/ui/components/select";
import { Spinner } from "@vantyr/ui/components/spinner";
import { Textarea } from "@vantyr/ui/components/textarea";
import { api } from "@/api";
import { settingsQueries } from "@/api/queries/settings";

interface BulkScriptModalProps {
  agentIds: string[];
  onDismiss: () => void;
}

export function BulkScriptModal({ agentIds, onDismiss }: BulkScriptModalProps) {
  const capabilitiesQuery = useQuery(settingsQueries.capabilities());
  // `null` while unknown; a failed check counts as "not allowed".
  const remoteOk = capabilitiesQuery.isError ? false : capabilitiesQuery.data?.remote_script ?? null;
  const [shell, setShell] = useState("powershell");
  const [script, setScript] = useState("hostname");
  const runScript = useMutation({
    mutationFn: (body: { agent_ids: string[]; shell: string; script: string; timeout_secs: number }) => api.bulkAgentScript(body),
  });
  const running = runScript.isPending;
  const err = runScript.error ? String(runScript.error) : null;
  const results: Record<string, unknown>[] | null = runScript.data ? runScript.data.results ?? [] : null;

  const run = () => {
    runScript.mutate({
      agent_ids: agentIds,
      shell,
      script,
      timeout_secs: 120,
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !running && onDismiss()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Run script on selected agents</DialogTitle>
          <DialogDescription>Runs once on each of the {agentIds.length} selected agent(s) with a 120s timeout.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {remoteOk === false && (
            <Alert variant="destructive">
              <AlertTitle>Remote scripting disabled</AlertTitle>
              <AlertDescription>
                Enable <code>ALLOW_REMOTE_SCRIPT_EXECUTION=true</code> on the server.
              </AlertDescription>
            </Alert>
          )}
          {err && (
            <Alert variant="destructive">
              <AlertDescription>{err}</AlertDescription>
            </Alert>
          )}
          <Field>
            <FieldLabel htmlFor="bulk-shell">Shell</FieldLabel>
            <Select value={shell} onValueChange={(next) => { if (typeof next === "string") setShell(next); }}>
              <SelectTrigger id="bulk-shell" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="powershell">PowerShell</SelectItem>
                <SelectItem value="cmd">Command Prompt (cmd)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="bulk-script">Script</FieldLabel>
            <Textarea
              id="bulk-script"
              rows={10}
              className="font-mono"
              value={script}
              onChange={(e) => setScript(e.target.value)}
              disabled={running || remoteOk === false}
              spellCheck={false}
            />
          </Field>
          {results && (
            <pre className="max-h-[360px] overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap">
              {JSON.stringify(results, null, 2)}
            </pre>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onDismiss}>
            Close
          </Button>
          <Button disabled={remoteOk === false || agentIds.length === 0 || running} onClick={() => void run()}>
            {running && <Spinner />} Run on {agentIds.length} agent(s)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
