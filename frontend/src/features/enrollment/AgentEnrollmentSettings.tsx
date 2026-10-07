import { useMemo, useState } from "react";
import { Copy, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PendingApprovalsCard } from "@/features/enrollment/PendingApprovalsCard";
import type { PendingAgentClaim } from "@/features/enrollment/PendingApprovalsCard";
import { formatEnrollmentOtp6 } from "@/features/enrollment/formatEnrollmentCode";

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
  enrollClaimsLoadedAt: Date | null;
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
  enrollClaimsLoadedAt,
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
  const [enrollUses, setEnrollUses] = useState(1);
  const [enrollExpireHours, setEnrollExpireHours] = useState("");
  const [enrollNote, setEnrollNote] = useState("");
  const [enrollLoading, setEnrollLoading] = useState(false);
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

  const handleGenerate = async () => {
    setEnrollLoading(true);
    setEnrollError(null);
    try {
      const uses = Math.max(1, Math.min(100_000, Number(enrollUses) || 1));
      const body: { uses: number; expires_in_hours?: number; note?: string } = { uses };
      const rawH = enrollExpireHours.trim();
      if (rawH !== "") {
        const h = Math.max(1, Math.min(24 * 365, parseInt(rawH, 10) || 0));
        if (h > 0) body.expires_in_hours = h;
      }
      if (enrollNote.trim()) body.note = enrollNote.trim();
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
    } finally {
      setEnrollLoading(false);
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
          <p className="text-sm text-muted-foreground">
            Create pairing codes and approve pending agents.
          </p>
          <PendingApprovalsCard
            claims={enrollClaims}
            loading={enrollClaimsLoading}
            lastRefreshedAt={enrollClaimsLoadedAt}
            onRefresh={onRefreshClaims}
            onApprove={onApproveClaim}
            onReject={onRejectClaim}
          />
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="enroll-uses">Uses</FieldLabel>
              <Input
                id="enroll-uses"
                type="number"
                inputMode="numeric"
                value={String(enrollUses)}
                onChange={(event) =>
                  setEnrollUses(Math.max(1, Math.min(100_000, Number(event.target.value) || 1)))
                }
                className="h-9"
              />
              <FieldDescription>How many claims can use this code.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="enroll-expire">Expires in (hours)</FieldLabel>
              <Input
                id="enroll-expire"
                value={enrollExpireHours}
                onChange={(event) => setEnrollExpireHours(event.target.value)}
                placeholder="e.g. 72"
                className="h-9"
              />
              <FieldDescription>Leave empty for 10 minutes.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="enroll-note">Note (optional)</FieldLabel>
              <Input
                id="enroll-note"
                value={enrollNote}
                onChange={(event) => setEnrollNote(event.target.value)}
                className="h-9"
              />
              <FieldDescription>Shown only in the API response.</FieldDescription>
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={enrollLoading} onClick={() => void handleGenerate()}>
              {enrollLoading && <Spinner />} Generate code
            </Button>
            {enrollResult ? (
              <Button variant="outline" onClick={() => void copyEnrollmentToken()}>
                <Copy /> {enrollCopied ? "Copied" : "Copy code"}
              </Button>
            ) : null}
          </div>
          {enrollError ? (
            <Alert variant="destructive">
              <AlertDescription>{enrollError}</AlertDescription>
            </Alert>
          ) : null}
          {enrollResult ? (
            <Alert>
              <AlertTitle className="text-success">Pairing code (6 digits)</AlertTitle>
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
              <h3 className="font-heading text-base font-medium">Keys</h3>
              <div className="flex flex-wrap items-center gap-2">
                {hasRevocable ? (
                  <Button variant="outline" size="sm" disabled={enrollTokensLoading} onClick={() => setRevokeAllOpen(true)}>
                    Revoke all
                  </Button>
                ) : null}
                <Button variant="outline" size="sm" disabled={enrollTokensLoading} onClick={() => void loadEnrollmentTokens()}>
                  {enrollTokensLoading ? <Spinner /> : <RefreshCw />} Refresh
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-3">
              {enrollTokensError ? (
                <Alert variant="destructive">
                  <AlertDescription>{enrollTokensError}</AlertDescription>
                </Alert>
              ) : null}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-3">Created</TableHead>
                    <TableHead className="px-3">Expires</TableHead>
                    <TableHead className="px-3">Uses left</TableHead>
                    <TableHead className="px-3">Used</TableHead>
                    <TableHead className="px-3">Last used</TableHead>
                    <TableHead className="px-3">Note</TableHead>
                    <TableHead className="px-3"><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {enrollTokensLoading && enrollTokens.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="px-3 py-8 text-center text-sm text-muted-foreground">
                        <span className="inline-flex items-center gap-2"><Spinner /> Loading keys…</span>
                      </TableCell>
                    </TableRow>
                  ) : enrollTokens.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="px-3 py-8 text-center text-sm text-muted-foreground">
                        No enrollment keys yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    enrollTokens.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell className="px-3 py-3.5">{new Date(t.created_at).toLocaleString()}</TableCell>
                        <TableCell className="px-3 py-3.5">{t.expires_at ? new Date(t.expires_at).toLocaleString() : "—"}</TableCell>
                        <TableCell className="px-3 py-3.5 font-mono tabular-nums">{String(t.uses_remaining ?? 0)}</TableCell>
                        <TableCell className="px-3 py-3.5 font-mono tabular-nums">{String(t.used_count ?? 0)}</TableCell>
                        <TableCell className="px-3 py-3.5">{t.last_used_at ? new Date(t.last_used_at).toLocaleString() : "—"}</TableCell>
                        <TableCell className="px-3 py-3.5">{t.note?.trim() ? t.note : "—"}</TableCell>
                        <TableCell className="px-3 py-3.5">
                          <div className="flex flex-wrap gap-2">
                            {(t.used_count ?? 0) > 0 ? (
                              <Button variant="ghost" size="sm" onClick={() => showUses(t)}>
                                View uses
                              </Button>
                            ) : null}
                            {(t.uses_remaining ?? 0) > 0 ? (
                              <Button variant="ghost" size="sm" onClick={() => setRevokeTokenId(t.id)}>
                                Revoke
                              </Button>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
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
