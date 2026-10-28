import { useMemo, useState } from "react";
import { Copy } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@vantyr/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@vantyr/ui/components/alert-dialog";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@vantyr/ui/components/card";
import { Spinner } from "@vantyr/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vantyr/ui/components/table";
import { PendingApprovalsCard } from "./PendingApprovalsCard";
import type { PendingAgentClaim } from "./PendingApprovalsCard";
import { EnrollmentTokenForm } from "./EnrollmentTokenForm";
import { formatEnrollmentOtp6 } from "./formatEnrollmentCode";
import type { EnrollmentTokenBody } from "./lib/enrollmentTokenForm";
import { RefreshButton } from "@/components/common/RefreshButton";
import { fmtFromNow } from "@/lib/utils";

interface EnrollmentToken {
  id: string;
  uses_remaining: number;
  created_at: string;
  expires_at: string | null;
  note: string | null;
  used_count: number;
  last_used_at: string | null;
}

interface AgentEnrollmentSettingsProps {
  isAdmin: boolean;
  enrollClaims: PendingAgentClaim[];
  enrollClaimsLoading: boolean;
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
  onListTokenUses: (id: string) => Promise<{ used_at: string; agent_name: string; agent_id: string | null }[]>;
}

export function AgentEnrollmentSettings({
  isAdmin,
  enrollClaims,
  enrollClaimsLoading,
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
  // Baseline for "expires in 3h": coarse labels, so the time the card opened is close enough.
  const [listedAt] = useState(() => Date.now());
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [enrollResult, setEnrollResult] = useState<{
    token: string;
    uses: number;
    expires_at: string | null;
  } | null>(null);
  const [enrollCopied, setEnrollCopied] = useState(false);
  const [revokeTokenId, setRevokeTokenId] = useState<string | null>(null);
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const [tokenUses, setTokenUses] = useState<Record<string, { loading: boolean; error: string | null; rows: { used_at: string; agent_name: string; agent_id: string | null }[] }>>(
    {},
  );

  const handleGenerate = async (body: EnrollmentTokenBody) => {
    setEnrollError(null);
    try {
      const r = await onGenerateToken(body);
      setEnrollResult({
        token: r.enrollment_token,
        uses: r.uses,
        expires_at: r.expires_at,
      });
      await loadEnrollmentTokens();
      await onRefreshClaims();
    } catch (e: unknown) {
      setEnrollError(String((e as { message?: string })?.message ?? e));
      setEnrollResult(null);
    }
  };

  const copyEnrollmentToken = async () => {
    if (!enrollResult?.token) return;
    try {
      await navigator.clipboard.writeText(enrollResult.token);
      setEnrollCopied(true);
      window.setTimeout(() => setEnrollCopied(false), 1800);
    } catch {
      /* ignore */
    }
  };

  const showUses = (t: EnrollmentToken) => {
    const cur = tokenUses[t.id];
    if (cur?.rows?.length || cur?.loading) return;
    setTokenUses((prev) => ({ ...prev, [t.id]: { loading: true, error: null, rows: [] } }));
    void onListTokenUses(t.id)
      .then((rows) => {
        setTokenUses((prev) => ({
          ...prev,
          [t.id]: { loading: false, error: null, rows },
        }));
      })
      .catch((e: unknown) => {
        setTokenUses((prev) => ({
          ...prev,
          [t.id]: {
            loading: false,
            error: String((e as { message?: string })?.message ?? e),
            rows: [],
          },
        }));
      });
  };

  const confirmRevoke = async () => {
    if (!revokeTokenId) return;
    setRevoking(true);
    try {
      await onRevokeToken(revokeTokenId);
      setRevokeTokenId(null);
      await loadEnrollmentTokens();
    } catch (e: unknown) {
      setEnrollTokensError(String((e as { message?: string })?.message ?? e));
    } finally {
      setRevoking(false);
    }
  };

  const confirmRevokeAll = async () => {
    setRevoking(true);
    setEnrollTokensError(null);
    try {
      await onRevokeAllTokens();
      setRevokeAllOpen(false);
      await loadEnrollmentTokens();
    } catch (e: unknown) {
      setEnrollTokensError(String((e as { message?: string })?.message ?? e));
    } finally {
      setRevoking(false);
    }
  };

  const visibleTokenUses = useMemo(
    () => Object.entries(tokenUses).filter(([, v]) => v.rows.length > 0 || v.loading || v.error),
    [tokenUses],
  );

  if (!isAdmin) return null;

  const hasRevocable = enrollTokens.some((t) => (t.uses_remaining ?? 0) > 0);

  return (
    <>
      <Card className="gap-0 py-0">
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle>Agent enrollment</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6 px-5 pb-5">
          <PendingApprovalsCard
            claims={enrollClaims}
            loading={enrollClaimsLoading}
            onRefresh={onRefreshClaims}
            onApprove={onApproveClaim}
            onReject={onRejectClaim}
          />
          <EnrollmentTokenForm
            layout="card"
            onGenerate={handleGenerate}
            extra={enrollResult ? (
              <Button variant="outline" onClick={() => void copyEnrollmentToken()}>
                <Copy /> {enrollCopied ? "Copied" : "Copy code"}
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
              <AlertTitle className="text-success">Pairing code</AlertTitle>
              <AlertDescription>
                <span className="mt-1 block font-mono text-2xl font-bold tracking-widest text-foreground">
                  {formatEnrollmentOtp6(enrollResult.token)}
                </span>
                <span className="mt-2 block text-sm">
                  Uses remaining after creation: {enrollResult.uses}
                  {enrollResult.expires_at
                    ? ` · Expires: ${new Date(enrollResult.expires_at).toLocaleString()}`
                    : ""}
                </span>
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="rounded-lg bg-muted/50 px-3.5 py-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-heading text-base font-medium">Pairing codes</h3>
              <div className="flex flex-wrap items-center gap-2">
                {hasRevocable ? (
                  <Button variant="outline" size="sm" disabled={enrollTokensLoading} onClick={() => setRevokeAllOpen(true)}>
                    Revoke all
                  </Button>
                ) : null}
                <RefreshButton onClick={() => void loadEnrollmentTokens()} loading={enrollTokensLoading} />
              </div>
            </div>
            <div className="flex flex-col gap-3">
              {enrollTokensError ? (
                <Alert variant="destructive">
                  <AlertDescription>{enrollTokensError}</AlertDescription>
                </Alert>
              ) : null}
              {enrollTokensLoading && enrollTokens.length === 0 ? (
                <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Spinner /> Loading…</p>
              ) : enrollTokens.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">No pairing codes yet.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border/50">
                  {enrollTokens.map((t) => {
                    const used = t.used_count ?? 0;
                    const left = t.uses_remaining ?? 0;
                    const details = [
                      left > 0 ? `${left} ${left === 1 ? "use" : "uses"} left` : "Used up",
                      t.expires_at ? (new Date(t.expires_at).getTime() > listedAt ? `expires ${fmtFromNow(new Date(t.expires_at), listedAt)}` : "expired") : "no expiry",
                      used > 0 ? `used ${used}×${t.last_used_at ? `, last ${fmtFromNow(new Date(t.last_used_at), listedAt)}` : ""}` : null,
                    ].filter(Boolean).join(" · ");
                    return (
                      <li key={t.id} className="flex items-center gap-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium" title={`Created ${new Date(t.created_at).toLocaleString()}`}>
                            {t.note?.trim() || "Pairing code"}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">{details}</div>
                        </div>
                        {used > 0 && (
                          <Button variant="ghost" size="sm" onClick={() => showUses(t)}>
                            Uses
                          </Button>
                        )}
                        {left > 0 && (
                          <Button variant="ghost" size="sm" onClick={() => setRevokeTokenId(t.id)}>
                            Revoke
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {visibleTokenUses.map(([tokenId, v]) => (
                <div key={tokenId} className="rounded-lg bg-background/50 px-3.5 py-3">
                  <h4 className="mb-2 font-heading text-sm font-medium break-words">Uses for <span className="font-mono text-xs break-all">{tokenId}</span></h4>
                  {v.error ? (
                    <Alert variant="destructive">
                      <AlertDescription>{v.error}</AlertDescription>
                    </Alert>
                  ) : null}
                  {v.loading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Spinner /> Loading…
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="px-3">Used at</TableHead>
                          <TableHead className="px-3">Agent name</TableHead>
                          <TableHead className="px-3">Agent id</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {v.rows.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={3} className="px-3 py-8 text-center text-sm text-muted-foreground">
                              No uses recorded yet.
                            </TableCell>
                          </TableRow>
                        ) : (
                          v.rows.map((r, idx) => (
                            <TableRow key={`${r.agent_id ?? r.agent_name}-${idx}`}>
                              <TableCell className="px-3 py-3.5">{new Date(r.used_at).toLocaleString()}</TableCell>
                              <TableCell className="px-3 py-3.5">{r.agent_name}</TableCell>
                              <TableCell className="px-3 py-3.5 font-mono text-xs">{r.agent_id ?? "—"}</TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  )}
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={revokeTokenId !== null} onOpenChange={(open) => !open && !revoking && setRevokeTokenId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this pairing code?</AlertDialogTitle>
            <AlertDialogDescription>It will become unusable.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={revoking} onClick={() => void confirmRevoke()}>
              {revoking && <Spinner />} Revoke code
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={revokeAllOpen} onOpenChange={(open) => !open && !revoking && setRevokeAllOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke all pairing codes?</AlertDialogTitle>
            <AlertDialogDescription>Any unused codes will become unusable.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={revoking} onClick={() => void confirmRevokeAll()}>
              {revoking && <Spinner />} Revoke all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
