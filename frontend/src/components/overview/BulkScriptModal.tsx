import { useEffect, useState } from "react";
import { Alert, Box, Button, FormField, Modal, Select, SpaceBetween } from "../ui/console";
import { api } from "../../lib/api";

interface BulkScriptModalProps {
  agentIds: string[];
  onDismiss: () => void;
}

export function BulkScriptModal({ agentIds, onDismiss }: BulkScriptModalProps) {
  const [remoteOk, setRemoteOk] = useState<boolean | null>(null);
  const [shell, setShell] = useState({ label: "PowerShell", value: "powershell" });
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
        shell: shell.value,
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
    <Modal
      onDismiss={onDismiss}
      visible
      size="large"
      header="Run script on selected agents"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss}>
              Close
            </Button>
            <Button
              variant="primary"
              loading={running}
              disabled={remoteOk === false || agentIds.length === 0}
              onClick={() => void run()}
            >
              Run on {agentIds.length} agent(s)
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="l">
        {remoteOk === false && (
          <Alert type="warning" header="Remote scripting disabled">
            Enable <code>ALLOW_REMOTE_SCRIPT_EXECUTION=true</code> on the server.
          </Alert>
        )}
        {err && <Alert type="error">{err}</Alert>}
        <FormField label="Shell">
          <Select
            selectedOption={shell}
            onChange={({ detail }) => {
              const o = detail.selectedOption;
              if (o?.value != null) {
                setShell({ label: o.label ?? String(o.value), value: String(o.value) });
              }
            }}
            options={[
              { label: "PowerShell", value: "powershell" },
              { label: "Command Prompt (cmd)", value: "cmd" },
            ]}
          />
        </FormField>
        <FormField label="Script">
          <textarea
            rows={10}
            style={{ width: "100%", fontFamily: "monospace", fontSize: "13px", padding: "8px" }}
            value={script}
            onChange={(e) => setScript(e.target.value)}
            disabled={running || remoteOk === false}
            spellCheck={false}
          />
        </FormField>
        {results && (
          <pre style={{ whiteSpace: "pre-wrap", fontSize: "11px", maxHeight: 360, overflow: "auto" }}>
            {JSON.stringify(results, null, 2)}
          </pre>
        )}
      </SpaceBetween>
    </Modal>
  );
}
