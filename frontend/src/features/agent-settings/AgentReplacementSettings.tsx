import { useState } from "react";
import { api } from "@/api";
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
        <CardTitle>Replace installation</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-5 pb-5 text-sm">
        <p className="text-muted-foreground">Reinstall or move, keeping history and settings.</p>
        <div>
          <Button variant="outline" onClick={() => { setError(null); setConfirm(true); }} disabled={busy}>Re-enroll</Button>
        </div>
        {code && (
          <Alert>
            <AlertDescription>
              <span className="block">Pairing code: <strong className="font-mono text-2xl">{code.value}</strong></span>
              <span className="mt-2 block text-muted-foreground">Single use; preserves this device’s UUID and name.</span>
              <span className="mt-1 block text-muted-foreground">{code.expiresAt ? `Expires ${new Date(code.expiresAt).toLocaleString()}.` : "Expires in 10 minutes."} Keep private.</span>
            </AlertDescription>
          </Alert>
        )}
        <Dialog open={confirm} onOpenChange={(open) => { if (!open && !busy) setConfirm(false); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Replace installation for {agentName}?</DialogTitle>
              <DialogDescription>
                The current install disconnects immediately. History and settings are kept.
              </DialogDescription>
            </DialogHeader>
            {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>Cancel</Button>
              <Button variant="destructive" disabled={busy} onClick={() => void replace()}><span>Revoke and create code</span>{busy && <Spinner />}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
