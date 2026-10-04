import { useState } from "react";
import { api } from "../lib/api";
import { Alert, Button, Container, Header, Modal, SpaceBetween } from "./ui/console";

export function AgentReplacementSettings({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<{ value: string; expiresAt: string | null } | null>(null);

  const replace = async () => {
    setBusy(true);
    setError(null);
    setCode(null);
    try {
      const body = { uses: 1, bound_agent_id: agentId };
      const result = await api.createAgentEnrollmentToken(body);
      const boundId = result.bound_agent_id;
      if (boundId !== agentId) {
        await api.revokeAgentEnrollmentToken(result.id);
        throw new Error("The server does not support device replacement yet. Update the server before re-enrolling.");
      }
      setCode({ value: result.enrollment_token, expiresAt: result.expires_at });
      setConfirm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Container header={<Header variant="h2">Replace installation / Re-enroll</Header>}>
      <SpaceBetween size="m">
        <div>Reinstall {agentName} or move it to a replacement computer while preserving its device UUID, history, and settings. The current installation’s credential is revoked and it disconnects.</div>
        <Button onClick={() => { setError(null); setConfirm(true); }} disabled={busy}>Replace installation / Re-enroll</Button>
        {code && (
          <Alert type="success">
            <div>Replacement pairing code: <strong style={{ fontFamily: "monospace", fontSize: 24 }}>{code.value}</strong></div>
            <div>Enter this one-use code in the new installation’s pairing screen. It preserves this device’s UUID and name even if the new computer has a different hostname.</div>
            <div>{code.expiresAt ? `Expires ${new Date(code.expiresAt).toLocaleString()}.` : "Expires in 10 minutes."} Keep this code private. Generating another invalidates this code.</div>
            <div>To add a separate device with its own history, use Add agent and a unique device name.</div>
          </Alert>
        )}
        <Modal visible={confirm} header={`Replace installation for ${agentName}?`} onDismiss={() => { if (!busy) setConfirm(false); }}
          footer={<SpaceBetween direction="horizontal" size="s"><Button disabled={busy} onClick={() => setConfirm(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void replace()}>Revoke credential and create replacement code</Button></SpaceBetween>}>
          <SpaceBetween size="m">
            <div>The current installation will disconnect immediately. Only the replacement installation should receive the new code. Existing history, UUID, groups, and settings are preserved.</div>
            <div>If pairing fails or the code expires, generate another replacement code here.</div>
            {error && <Alert type="error">{error}</Alert>}
          </SpaceBetween>
        </Modal>
      </SpaceBetween>
    </Container>
  );
}
