import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

/** Only when the device cannot find this server by itself: what an admin has to fix. */
function discoveryProblem(h: AgentSetupHints): string | null {
  if (h.mdns === "advertising") return null;
  if (h.mdns === "disabled_by_env") return "LAN discovery is off on this server, so paste the URL on the device.";
  return "The server has no public URL set (PUBLIC_BASE_URL), so the device cannot find it. Use the wss:// address you reach this dashboard on.";
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

  const problem = hints ? discoveryProblem(hints) : null;

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
          <DialogTitle>Enroll agent</DialogTitle>
          <DialogDescription>Pair a device that has the Vantyr agent installed.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          {hintsErr ? (
            <Alert variant="destructive">
              <AlertDescription>{hintsErr}</AlertDescription>
            </Alert>
          ) : null}
          {problem ? (
            <Alert variant="destructive">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          ) : null}
          <ol className="grid list-decimal gap-3 pl-5 text-sm marker:text-muted-foreground">
            <li>
              On the device, open Vantyr settings{" "}
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-sans text-xs">Ctrl+Shift+F12</kbd>.
            </li>
            <li>
              <span>
                {hints?.mdns === "advertising" ? "Choose Discover server, or paste this address:" : "Paste this server address:"}
              </span>
              {hintsLoading && !hints ? (
                <span className="mt-2 block text-muted-foreground">Loading…</span>
              ) : hints?.agent_wss_url ? (
                <span className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="rounded bg-muted px-2 py-1 font-mono text-xs break-all">{hints.agent_wss_url}</code>
                  <Button variant="ghost" size="sm" onClick={() => void copyWithFeedback("wss", hints.agent_wss_url!)}>
                    <Copy /> {copied === "wss" ? "Copied" : "Copy"}
                  </Button>
                </span>
              ) : null}
            </li>
            <li>Generate a code here and enter it under Request access, then approve the device below.</li>
          </ol>

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
            <div className="rounded-lg bg-muted/50 px-4 py-3">
              <span className="block font-mono text-2xl font-bold tracking-widest">
                {formatEnrollmentOtp6(enrollResult.token)}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {enrollResult.uses === 1 ? "1 use" : `${enrollResult.uses} uses`}
                {enrollResult.expires_at ? ` · expires ${new Date(enrollResult.expires_at).toLocaleString()}` : ""}
              </span>
            </div>
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
      </DialogContent>
    </Dialog>
  );
}
