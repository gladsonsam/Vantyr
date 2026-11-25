import { useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@vantyr/ui/components/card";
import { errorText } from "@/api/client";
import { PendingApprovalsCard } from "./PendingApprovalsCard";
import type { PendingAgentClaim } from "./PendingApprovalsCard";
import { EnrollmentTokenForm } from "./EnrollmentTokenForm";
import { PairingCodeList, type EnrollmentToken, type TokenUse } from "./PairingCodeList";
import { formatEnrollmentOtp6 } from "./formatEnrollmentCode";
import type { EnrollmentTokenBody } from "./lib/enrollmentTokenForm";

interface AgentEnrollmentSettingsProps {
  isAdmin: boolean;
  enrollClaims: PendingAgentClaim[];
  enrollClaimsLoading: boolean;
  /** Why the waiting-for-approval check failed; without it an empty list means nothing is waiting. */
  enrollClaimsError?: string | null;
  onRefreshClaims: () => Promise<void>;
  onApproveClaim: (claim: PendingAgentClaim, agentName: string) => Promise<void>;
  onRejectClaim: (claim: PendingAgentClaim) => Promise<void>;

  enrollTokens: EnrollmentToken[];
  enrollTokensLoading: boolean;
  enrollTokensError: string | null;
  setEnrollTokensError: (err: string | null) => void;
  loadEnrollmentTokens: () => Promise<void>;

  onGenerateToken: (body: { uses: number; expires_in_hours?: number; note?: string }) => Promise<{ enrollment_token: string; uses: number; expires_at: string | null }>;
  onRevokeToken: (id: string) => Promise<void>;
  onRevokeAllTokens: () => Promise<void>;
  onListTokenUses: (id: string) => Promise<TokenUse[]>;
}

export function AgentEnrollmentSettings({
  isAdmin,
  enrollClaims,
  enrollClaimsLoading,
  enrollClaimsError = null,
  onRefreshClaims,
  onApproveClaim,
  onRejectClaim,
  enrollTokens,
  enrollTokensLoading,
  enrollTokensError,
  setEnrollTokensError,
  loadEnrollmentTokens,
  onGenerateToken,
  onRevokeToken,
  onRevokeAllTokens,
  onListTokenUses,
}: AgentEnrollmentSettingsProps) {
  const [listedAt] = useState(() => Date.now());
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [enrollResult, setEnrollResult] = useState<{
    token: string;
    uses: number;
    expires_at: string | null;
  } | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const generateRequest = useRef(0);
  useEffect(() => () => { generateRequest.current += 1; }, []);
  const handleGenerate = async (body: EnrollmentTokenBody) => {
    const request = ++generateRequest.current;
    setEnrollError(null);
    setCopyState("idle");
    try {
      const r = await onGenerateToken(body);
      if (generateRequest.current !== request) return;
      setEnrollResult({
        token: r.enrollment_token,
        uses: r.uses,
        expires_at: r.expires_at,
      });
      await loadEnrollmentTokens();
      await onRefreshClaims();
    } catch (e: unknown) {
      if (generateRequest.current !== request) return;
      setEnrollError(errorText(e));
      setEnrollResult(null);
    }
  };

  const copyEnrollmentToken = async () => {
    if (!enrollResult?.token) return;
    try {
      await navigator.clipboard.writeText(enrollResult.token);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("failed");
    }
  };

  if (!isAdmin) return null;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle>Agent enrollment</CardTitle>
        <CardDescription>
          Generate a pairing code and enter it on the new device. A device that asks to join without a code waits below for your approval.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6 px-5 pt-3 pb-5">
        {enrollClaimsError ? (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>Couldn't check for devices waiting for approval. {enrollClaimsError}</span>
              <Button variant="outline" size="sm" onClick={() => void onRefreshClaims()}>Try again</Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <PendingApprovalsCard
          claims={enrollClaims}
          loading={enrollClaimsLoading}
          onRefresh={onRefreshClaims}
          onApprove={onApproveClaim}
          onReject={onRejectClaim}
        />
        <section aria-labelledby="new-code-heading" className="flex flex-col gap-4">
          <h3 id="new-code-heading" className="font-heading text-base font-medium">New pairing code</h3>
          <EnrollmentTokenForm
            layout="card"
            onGenerate={handleGenerate}
            extra={enrollResult ? (
              <Button variant="outline" onClick={() => void copyEnrollmentToken()}>
                <Copy /> {copyState === "copied" ? "Copied" : "Copy code"}
              </Button>
            ) : null}
          />
          {enrollError ? (
            <Alert variant="destructive">
              <AlertDescription>Couldn't generate a code. {enrollError}</AlertDescription>
            </Alert>
          ) : null}
          {enrollResult ? (
            <Alert>
              <AlertTitle className="text-success">Pairing code</AlertTitle>
              <AlertDescription>
                <span className="mt-1 block font-mono text-2xl font-bold tracking-widest text-foreground">
                  {formatEnrollmentOtp6(enrollResult.token)}
                </span>
                <span className="mt-2 block text-sm">
                  {enrollResult.uses === 1 ? "1 use" : `${enrollResult.uses} uses`}
                  {enrollResult.expires_at
                    ? ` · expires ${new Date(enrollResult.expires_at).toLocaleString()}`
                    : " · no expiry"}
                </span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  Enter it on the new device. It is shown only now; the list below never shows the code again.
                </span>
                {copyState === "failed" ? (
                  <span role="status" className="mt-1 block text-sm text-destructive">Couldn't copy automatically. Select the code and copy it by hand.</span>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
        </section>

        <PairingCodeList
          tokens={enrollTokens}
          loading={enrollTokensLoading}
          error={enrollTokensError}
          listedAt={listedAt}
          onRefresh={loadEnrollmentTokens}
          onRevoke={onRevokeToken}
          onRevokeAll={onRevokeAllTokens}
          onListUses={onListTokenUses}
          onClearError={() => setEnrollTokensError(null)}
        />
      </CardContent>
    </Card>
  );
}
