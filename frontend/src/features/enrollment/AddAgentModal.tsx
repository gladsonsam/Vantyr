import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
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
import { api } from "@/api";
import { enrollmentKeys, enrollmentQueries } from "@/api/queries/enrollment";
import { EnrollmentTokenForm } from "./EnrollmentTokenForm";
import { formatEnrollmentOtp6 } from "./formatEnrollmentCode";
import type { EnrollmentTokenBody } from "./lib/enrollmentTokenForm";
import { PendingApprovalsCard, type PendingAgentClaim } from "./PendingApprovalsCard";

type AgentSetupHints = {
  mdns: "advertising" | "disabled_by_env" | "unavailable_no_wss_url";
  agent_wss_url: string | null;
  mdns_port: number;
};

interface AddAgentModalProps {
  visible: boolean;
  onDismiss: () => void;
}

const NO_CLAIMS: PendingAgentClaim[] = [];

/** `e.message`, falling back to the value itself. */
function messageOf(e: unknown): string {
  return String((e as { message?: string })?.message ?? e);
}

function hintsInstruction(h: AgentSetupHints): { variant: "default" | "destructive"; title: string; body: string } {
  if (h.mdns === "advertising") {
    return {
      variant: "default",
      title: "LAN discovery is on",
      body: `This server advertises Vantyr on the LAN (mDNS service _vantyr._tcp, port ${h.mdns_port}). On the Windows PC, open agent settings (Ctrl+Shift+F12): use Discover server, or paste the WebSocket URL below, then Request access.`,
    };
  }
  if (h.mdns === "disabled_by_env") {
    return {
      variant: "destructive",
      title: "LAN discovery is off",
      body: "mDNS is disabled on this server (VANTYR_MDNS=0 or VANTYR_MDNS_DISABLE=1). Enter the WebSocket URL manually on the agent. If no URL appears below, set PUBLIC_BASE_URL or VANTYR_MDNS_WSS_URL on the server.",
    };
  }
  return {
    variant: "destructive",
    title: "WebSocket URL not configured",
    body: "Set PUBLIC_BASE_URL=https://… or VANTYR_MDNS_WSS_URL=wss://…/ws/agent on the server, then reopen this dialog. Until then, use the wss:// URL that matches how you reach this dashboard.",
  };
}

export function AddAgentModal({ visible, onDismiss }: AddAgentModalProps) {
  const queryClient = useQueryClient();
  // Re-read on every open.
  const hintsQuery = useQuery({ ...enrollmentQueries.setupHints(), enabled: visible });
  const hints: AgentSetupHints | null = hintsQuery.isError ? null : hintsQuery.data ?? null;
  const hintsErr = hintsQuery.error ? messageOf(hintsQuery.error) : null;
  const hintsLoading = hintsQuery.isFetching;

  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [enrollResult, setEnrollResult] = useState<{
    token: string;
    uses: number;
    expires_at: string | null;
  } | null>(null);
  // Pending approvals refresh every 5 s while the dialog is open (shared with the fleet page's card).
  const claimsQuery = useQuery({ ...enrollmentQueries.claims(), enabled: visible, refetchInterval: 5000 });
  const claims: PendingAgentClaim[] = claimsQuery.data?.claims ?? NO_CLAIMS;
  const claimsLoading = claimsQuery.isFetching;
  const claimsError = claimsQuery.error ? messageOf(claimsQuery.error) : null;
  const claimsLoadedAt = claimsQuery.dataUpdatedAt ? new Date(claimsQuery.dataUpdatedAt) : null;
  const [copied, setCopied] = useState<"wss" | "code" | null>(null);

  const loadClaims = () => queryClient.invalidateQueries({ queryKey: enrollmentKeys.claims() });

  const [prevVisible, setPrevVisible] = useState(false);

  if (visible !== prevVisible) {
    setPrevVisible(visible);
    if (visible) {
      setEnrollResult(null);
      setEnrollError(null);
    }
  }

  const generateEnrollmentToken = async (body: EnrollmentTokenBody) => {
    setEnrollError(null);
    try {
      const r = await api.createAgentEnrollmentToken(body);
      setEnrollResult({
        token: r.enrollment_token,
        uses: r.uses,
        expires_at: r.expires_at,
      });
      await loadClaims();
    } catch (e: unknown) {
      setEnrollError(String((e as { message?: string })?.message ?? e));
      setEnrollResult(null);
    }
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  };

  const instruct = hints ? hintsInstruction(hints) : null;

  const copyWithFeedback = async (kind: "wss" | "code", text: string) => {
    if (!(await copyText(text))) return;
    setCopied(kind);
    window.setTimeout(() => {
      setCopied((current) => (current === kind ? null : current));
    }, 1800);
  };

  const approveClaim = async (claim: PendingAgentClaim, agentName: string) => {
    await api.approveAgentEnrollmentClaim(claim.id, { agent_name: agentName });
    await loadClaims();
  };

  const rejectClaim = async (claim: PendingAgentClaim) => {
    await api.rejectAgentEnrollmentClaim(claim.id);
    await loadClaims();
  };

  return (
    <Dialog open={visible} onOpenChange={(open) => !open && onDismiss()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add agent</DialogTitle>
          <DialogDescription>Generate a pairing code, then approve the device when it asks to join.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {hintsLoading ? <p className="text-sm text-muted-foreground">Loading server hints…</p> : null}
          {hintsErr ? (
            <Alert variant="destructive">
              <AlertDescription>{hintsErr}</AlertDescription>
            </Alert>
          ) : null}
          {instruct ? (
            <Alert variant={instruct.variant}>
              <AlertTitle>{instruct.title}</AlertTitle>
              <AlertDescription>{instruct.body}</AlertDescription>
            </Alert>
          ) : null}
          {hints?.agent_wss_url ? (
            <div className="grid gap-2">
              <p className="text-sm text-muted-foreground">Agent WebSocket URL</p>
              <code className="font-mono text-sm break-all">{hints.agent_wss_url}</code>
              <div>
                <Button variant="outline" size="sm" onClick={() => void copyWithFeedback("wss", hints.agent_wss_url!)}>
                  <Copy /> {copied === "wss" ? "Copied" : "Copy WebSocket URL"}
                </Button>
              </div>
            </div>
          ) : null}

          <p className="text-sm text-muted-foreground">
            Generates a <strong className="text-foreground">6-digit</strong> pairing code. On the PC use{" "}
            <strong className="text-foreground">Request access</strong> in the agent settings. Codes create pending agents
            and expire after 10 minutes by default.
          </p>
          <EnrollmentTokenForm
            layout="dialog"
            onGenerate={generateEnrollmentToken}
            extra={enrollResult ? (
              <Button variant="outline" onClick={() => void copyWithFeedback("code", enrollResult.token)}>
                <Copy /> {copied === "code" ? "Copied" : "Copy code"}
              </Button>
            ) : null}
          />
          {enrollError ? (
            <Alert variant="destructive">
              <AlertDescription>{enrollError}</AlertDescription>
            </Alert>
          ) : null}
          {enrollResult ? (
            <Alert>
              <AlertTitle>Pairing code (6 digits)</AlertTitle>
              <AlertDescription>
                <span className="mt-1 block font-mono text-2xl font-bold tracking-widest text-foreground">
                  {formatEnrollmentOtp6(enrollResult.token)}
                </span>
                <span className="mt-1 block text-xs">
                  Uses remaining: {enrollResult.uses}
                  {enrollResult.expires_at ? ` · Expires: ${new Date(enrollResult.expires_at).toLocaleString()}` : ""}
                </span>
              </AlertDescription>
            </Alert>
          ) : null}
          <PendingApprovalsCard
            claims={claims}
            loading={claimsLoading}
            lastRefreshedAt={claimsLoadedAt}
            onRefresh={loadClaims}
            onApprove={approveClaim}
            onReject={rejectClaim}
          />
          {claimsError ? (
            <Alert variant="destructive">
              <AlertDescription>{claimsError}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onDismiss}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
