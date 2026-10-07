import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/api";

interface BulkScriptModalProps {
  agentIds: string[];
  onDismiss: () => void;
}

export function BulkScriptModal({ agentIds, onDismiss }: BulkScriptModalProps) {
  const [remoteOk, setRemoteOk] = useState<boolean | null>(null);
  const [shell, setShell] = useState("powershell");
  const [script, setScript] = useState("hostname");
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, unknown>[] | null>(null);

  useEffect(() => {
    api
      .capabilities()
      .then((c) => setRemoteOk(c.remote_script))
      .catch(() => setRemoteOk(false));
  }, []);

  const run = async () => {
    setErr(null);
    setResults(null);
    setRunning(true);
    try {
      const out = await api.bulkAgentScript({
        agent_ids: agentIds,
        shell,
        script,
        timeout_secs: 120,
      });
      setResults(out.results ?? []);
    } catch (e) {
      setErr(String(e));
    } finally {
      setRunning(false);
    }
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
