import { useMemo, useState } from "react";
import { Check, RefreshCw, ShieldQuestion, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export type PendingAgentClaim = {
  id: string;
  status: "pending" | "approved" | "rejected" | "expired";
  requested_name: string;
  hostname: string | null;
  os?: string | null;
  agent_version: string | null;
  client_ip: string | null;
  discovered_server?: string | null;
  created_at: string;
};

function formatRelativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function ClaimMeta({ claim }: { claim: PendingAgentClaim }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 xl:grid-cols-4">
      {[
        ["Host", claim.hostname ?? "-"],
        ["IP", claim.client_ip ?? "-"],
        ["Agent", claim.agent_version ?? "-"],
      ].map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-[11px] text-muted-foreground">{label}</dt>
          <dd className="truncate font-mono text-xs">{value}</dd>
        </div>
      ))}
      <div>
        <dt className="text-[11px] text-muted-foreground">First seen</dt>
        <dd className="font-mono text-xs">
          <time dateTime={claim.created_at} title={new Date(claim.created_at).toLocaleString()}>
            {formatRelativeTime(claim.created_at)}
          </time>
        </dd>
      </div>
    </dl>
  );
}

interface Props {
  claims: PendingAgentClaim[];
  loading?: boolean;
  lastRefreshedAt?: Date | null;
  onRefresh?: () => void | Promise<void>;
  onApprove: (claim: PendingAgentClaim, agentName: string) => void | Promise<void>;
  onReject: (claim: PendingAgentClaim) => void | Promise<void>;
}

export function PendingApprovalsCard({ claims, loading = false, lastRefreshedAt = null, onRefresh, onApprove, onReject }: Props) {
  const pending = useMemo(() => claims.filter((claim) => claim.status === "pending"), [claims]);
  const [approveClaim, setApproveClaim] = useState<PendingAgentClaim | null>(null);
  const [rejectClaim, setRejectClaim] = useState<PendingAgentClaim | null>(null);
  const [agentName, setAgentName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (pending.length === 0) return null;

  const close = () => {
    if (busy) return;
    setApproveClaim(null);
    setRejectClaim(null);
    setError(null);
  };
  const run = async (action: () => void | Promise<void>, done: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      done();
    } catch (e: unknown) {
      setError(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card className="gap-0 bg-linear-to-br from-primary/[0.07] to-transparent to-50% py-0">
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle className="flex items-center gap-2">
            <ShieldQuestion className="size-4 text-primary" />
            Pending approval
            <span className="font-mono text-sm text-primary tabular-nums">{pending.length}</span>
          </CardTitle>
          <CardDescription>
            New agents asked to join the fleet.{" "}
            {loading ? "Refreshing…" : lastRefreshedAt ? `Updated ${lastRefreshedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}
          </CardDescription>
          {onRefresh && (
            <CardAction>
              <Button variant="ghost" size="sm" disabled={loading} onClick={() => void onRefresh()}>
                <RefreshCw className={cn(loading && "animate-spin")} /> Refresh
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="divide-y divide-foreground/[0.05] px-0 pb-1">
          {pending.map((claim) => (
            <div key={claim.id} className="flex flex-col gap-4 px-5 py-4 lg:flex-row lg:items-center lg:gap-8">
              <div className="min-w-0 lg:w-56">
                <div className="truncate font-medium">{claim.requested_name}</div>
                <div className="text-xs text-muted-foreground">Waiting for an admin</div>
              </div>
              <div className="min-w-0 flex-1">
                <ClaimMeta claim={claim} />
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    setAgentName(claim.requested_name);
                    setApproveClaim(claim);
                  }}
                >
                  <Check /> Approve
                </Button>
                <Button size="sm" variant="outline" onClick={() => setRejectClaim(claim)}>
                  <X /> Reject
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Dialog open={approveClaim !== null} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-md">
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!approveClaim) return;
              void run(() => onApprove(approveClaim, agentName.trim() || approveClaim.requested_name), () => setApproveClaim(null));
            }}
          >
            <DialogHeader>
              <DialogTitle>Approve device</DialogTitle>
              <DialogDescription>The agent will connect and start reporting as soon as it is approved.</DialogDescription>
            </DialogHeader>
            {approveClaim && (
              <>
                <Field>
                  <FieldLabel htmlFor="approve-agent-name">Device name</FieldLabel>
                  <Input id="approve-agent-name" autoFocus value={agentName} onChange={(event) => setAgentName(event.target.value)} />
                  <FieldDescription>This is the name Vantyr will show in the dashboard.</FieldDescription>
                </Field>
                <div className="rounded-lg bg-muted/50 p-3">
                  <ClaimMeta claim={approveClaim} />
                </div>
              </>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Spinner />} Approve device
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={rejectClaim !== null} onOpenChange={(open) => !open && close()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject {rejectClaim?.requested_name ?? "this device"}?</AlertDialogTitle>
            <AlertDialogDescription>The agent will need to request access again before it can connect.</AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => rejectClaim && void run(() => onReject(rejectClaim), () => setRejectClaim(null))}
            >
              {busy && <Spinner />} Reject
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
