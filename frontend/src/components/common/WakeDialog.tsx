import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@vantyr/ui/components/dialog";
import { Button } from "@vantyr/ui/components/button";
import { Input } from "@vantyr/ui/components/input";

export function WakeDialog({ open, onOpenChange, onSend }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSend: (opts: { broadcast: string; port: number }) => Promise<void>;
}) {
  const [broadcast, setBroadcast] = useState("255.255.255.255");
  const [port, setPort] = useState("9");
  const [sending, setSending] = useState(false);
  const validAddress = /^\d{1,3}(\.\d{1,3}){3}$/.test(broadcast.trim()) &&
    broadcast.trim().split(".").every((part) => Number(part) <= 255 && String(Number(part)) === part);
  const validPort = /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!sending) onOpenChange(value); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send Wake-on-LAN packet</DialogTitle>
          <DialogDescription>
            The server sends directly to the selected destination. Sending a packet does not confirm awakening; wait for the agent to come online.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={async (event) => {
          event.preventDefault();
          if (sending || !validAddress || !validPort) return;
          setSending(true);
          try { await onSend({ broadcast: broadcast.trim(), port: Number(port) }); onOpenChange(false); }
          finally { setSending(false); }
        }}>
          <label className="grid gap-2">IPv4 broadcast address
            <Input value={broadcast} onChange={(event) => setBroadcast(event.target.value)} required disabled={sending} />
          </label>
          <label className="grid gap-2">UDP port
            <Input type="number" min={1} max={65535} step={1} value={port} onChange={(event) => setPort(event.target.value)} required disabled={sending} />
          </label>
          <p className="text-sm text-muted-foreground">Keep the defaults for the existing same-VLAN behavior. For another VLAN, enter that subnet’s broadcast address. Its router must support and allow directed broadcasts, and firewalls must permit the UDP traffic. For a fleet selection, this destination applies to every selected device; send separately for each VLAN.</p>
          {(!validAddress || !validPort) && <p role="alert" className="text-sm text-destructive">Enter an IPv4 address without leading zeros and a UDP port from 1 to 65535.</p>}
          <Button type="submit" disabled={sending || !validAddress || !validPort}>{sending ? "Sending…" : "Send packet"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
