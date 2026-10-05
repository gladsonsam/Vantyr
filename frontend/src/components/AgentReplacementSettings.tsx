import { useState } from "react";
import { api } from "../lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

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
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle>Replace installation / Re-enroll</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-5 pb-5 text-sm">
        <p className="text-muted-foreground">Reinstall {agentName} or move it to a replacement computer while preserving its device UUID, history, and settings. The current installation’s credential is revoked and it disconnects.</p>
        <div>
          <Button variant="outline" onClick={() => { setError(null); setConfirm(true); }} disabled={busy}>Replace installation / Re-enroll</Button>
        </div>
        {code && (
          <Alert>
            <AlertDescription>
              <span className="block">Replacement pairing code: <strong className="font-mono text-2xl">{code.value}</strong></span>
              <span className="mt-2 block text-muted-foreground">Enter this one-use code in the new installation’s pairing screen. It preserves this device’s UUID and name even if the new computer has a different hostname.</span>
              <span className="mt-1 block text-muted-foreground">{code.expiresAt ? `Expires ${new Date(code.expiresAt).toLocaleString()}.` : "Expires in 10 minutes."} Keep this code private. Generating another invalidates this code.</span>
              <span className="mt-1 block text-muted-foreground">To add a separate device with its own history, use Add agent and a unique device name.</span>
            </AlertDescription>
          </Alert>
        )}
        <Dialog open={confirm} onOpenChange={(open) => { if (!open && !busy) setConfirm(false); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Replace installation for {agentName}?</DialogTitle>
              <DialogDescription>
                The current installation will disconnect immediately. Only the replacement installation should receive the new code. Existing history, UUID, groups, and settings are preserved.
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">If pairing fails or the code expires, generate another replacement code here.</p>
            {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>Cancel</Button>
              <Button variant="destructive" disabled={busy} onClick={() => void replace()}><span>Revoke credential and create replacement code</span>{busy && <Spinner />}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
