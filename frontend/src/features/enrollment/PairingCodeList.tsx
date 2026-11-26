import { useRef, useState } from "react";
import { CircleCheck, CircleSlash, Clock } from "lucide-react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
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
import { Spinner } from "@vantyr/ui/components/spinner";
import { RefreshButton } from "@/components/common/RefreshButton";
import { errorText } from "@/api/client";
import { fmtFromNow } from "@/lib/utils";

export interface EnrollmentToken {
  id: string;
  uses_remaining: number;
  created_at: string;
  expires_at: string | null;
  note: string | null;
  used_count: number;
  last_used_at: string | null;
}
export type TokenUse = { used_at: string; agent_name: string; agent_id: string | null };
type UsesState = { loading: boolean; error: string | null; rows: TokenUse[] };

const codeName = (t: EnrollmentToken) => t.note?.trim() || "Pairing code";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Where a code stands: usable, past its expiry, or out of uses (used up or revoked). */
function codeStatus(
  t: EnrollmentToken,
  now: number,
): { label: string; Icon: typeof CircleCheck; tone: string } {
  const left = t.uses_remaining ?? 0;
  const expired = !!t.expires_at && new Date(t.expires_at).getTime() <= now;
  if (left <= 0) {
    return {
      label: (t.used_count ?? 0) > 0 ? "Used up" : "Revoked or used up",
      Icon: CircleSlash,
      tone: "text-muted-foreground",
    };
  }
  if (expired) return { label: "Expired", Icon: Clock, tone: "text-warning" };
  return { label: `${plural(left, "use", "uses")} left`, Icon: CircleCheck, tone: "text-success" };
}

function codeDetails(t: EnrollmentToken, now: number): string {
  const used = t.used_count ?? 0;
  const left = t.uses_remaining ?? 0;
  const expires = t.expires_at ? new Date(t.expires_at) : null;
  return [
    expires && left > 0 && expires.getTime() > now ? `expires ${fmtFromNow(expires, now)}` : null,
    !expires && left > 0 ? "no expiry" : null,
    used > 0
      ? `used ${used}×${t.last_used_at ? `, last ${fmtFromNow(new Date(t.last_used_at), now)}` : ""}`
      : null,
    `created ${fmtFromNow(new Date(t.created_at), now)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The pairing codes already made: status, uses, and revoke for one or all. */
export function PairingCodeList({
  tokens,
  loading,
  error,
  listedAt,
  onRefresh,
  onRevoke,
  onRevokeAll,
  onListUses,
  onClearError,
}: {
  tokens: EnrollmentToken[];
  loading: boolean;
  error: string | null;
  /** Baseline for "expires in 3h": coarse labels, so the time the card opened is close enough. */
  listedAt: number;
  onRefresh: () => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
  onRevokeAll: () => Promise<void>;
  onListUses: (id: string) => Promise<TokenUse[]>;
  onClearError: () => void;
}) {
  const [uses, setUses] = useState<Record<string, UsesState>>({});
  const [openUses, setOpenUses] = useState<Set<string>>(new Set());
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const revokedRef = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);

  const revocable = tokens.filter((t) => (t.uses_remaining ?? 0) > 0);
  const revokeTarget = tokens.find((t) => t.id === revokeId) ?? null;

  const loadUses = (id: string) => {
    setUses((prev) => ({ ...prev, [id]: { loading: true, error: null, rows: [] } }));
    onListUses(id).then(
      (rows) => setUses((prev) => ({ ...prev, [id]: { loading: false, error: null, rows } })),
      (e: unknown) =>
        setUses((prev) => ({ ...prev, [id]: { loading: false, error: errorText(e), rows: [] } })),
    );
  };
  const toggleUses = (id: string) => {
    const wasOpen = openUses.has(id);
    setOpenUses((prev) => {
      const next = new Set(prev);
      if (wasOpen) next.delete(id);
      else next.add(id);
      return next;
    });
    const cur = uses[id];
    if (!wasOpen && !cur?.loading && !cur?.rows.length) loadUses(id);
  };

  const closeDialogs = () => {
    if (revoking) return;
    setRevokeId(null);
    setRevokeAllOpen(false);
    setDialogError(null);
  };
  const confirm = async (action: () => Promise<void>) => {
    setRevoking(true);
    setDialogError(null);
    onClearError();
    try {
      await action();
      revokedRef.current = true;
      setRevokeId(null);
      setRevokeAllOpen(false);
      await onRefresh();
    } catch (e) {
      setDialogError(errorText(e));
    } finally {
      setRevoking(false);
    }
  };
  const openRevoke = (id: string | null) => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRevokeId(id);
    setRevokeAllOpen(id === null);
  };
  // Cancel returns to the button that opened the dialog; after a revoke that button may be gone,
  // so focus moves to the list heading instead.
  const finalFocus = () => {
    const revoked = revokedRef.current;
    revokedRef.current = false;
    return (revoked ? headingRef.current : openerRef.current) ?? true;
  };

  return (
    <section aria-labelledby="pairing-codes-heading" className="rounded-xl border border-border/70 bg-card/10 px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3
          id="pairing-codes-heading"
          ref={headingRef}
          tabIndex={-1}
          className="font-heading text-base font-medium outline-none"
        >
          Pairing codes
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {revocable.length > 0 ? (
            <Button variant="outline" size="sm" disabled={loading} onClick={() => openRevoke(null)}>
              Revoke all
            </Button>
          ) : null}
          <RefreshButton
            onClick={() => void onRefresh()}
            loading={loading}
            label="Refresh pairing codes"
          />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>{error}</span>
              <Button variant="outline" size="sm" onClick={() => void onRefresh()}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {loading && tokens.length === 0 ? (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </p>
        ) : tokens.length === 0 ? (
          // A failed load already said so above; an empty list is only reported when the load worked.
          error ? null : (
            <p className="py-4 text-sm text-muted-foreground">
              No pairing codes yet. Generate one above to enroll a device.
            </p>
          )
        ) : (
          <ul className="flex flex-col divide-y divide-border/50">
            {tokens.map((t) => (
              <CodeRow
                key={t.id}
                token={t}
                now={listedAt}
                uses={uses[t.id]}
                usesOpen={openUses.has(t.id)}
                onToggleUses={() => toggleUses(t.id)}
                onRetryUses={() => loadUses(t.id)}
                onRevoke={() => openRevoke(t.id)}
              />
            ))}
          </ul>
        )}
      </div>

      <AlertDialog open={revokeId !== null} onOpenChange={(open) => !open && closeDialogs()}>
        <AlertDialogContent finalFocus={finalFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke {revokeTarget ? `“${codeName(revokeTarget)}”` : "this code"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              No new device can join with it after this. Devices that already joined with it stay
              connected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {dialogError ? (
            <Alert variant="destructive">
              <AlertDescription>Not revoked. {dialogError}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={revoking}
              onClick={() => revokeId && void confirm(() => onRevoke(revokeId))}
            >
              {revoking && <Spinner />} Revoke code
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={revokeAllOpen} onOpenChange={(open) => !open && closeDialogs()}>
        <AlertDialogContent finalFocus={finalFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke {plural(revocable.length, "pairing code", "pairing codes")}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every code that still has uses left stops working, so no new device can join with
              them. Devices that already joined stay connected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {dialogError ? (
            <Alert variant="destructive">
              <AlertDescription>Not revoked. {dialogError}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={revoking}
              onClick={() => void confirm(onRevokeAll)}
            >
              {revoking && <Spinner />} Revoke all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function CodeRow({
  token: t,
  now,
  uses,
  usesOpen,
  onToggleUses,
  onRetryUses,
  onRevoke,
}: {
  token: EnrollmentToken;
  now: number;
  uses: UsesState | undefined;
  usesOpen: boolean;
  onToggleUses: () => void;
  onRetryUses: () => void;
  onRevoke: () => void;
}) {
  const status = codeStatus(t, now);
  const name = codeName(t);
  const used = t.used_count ?? 0;
  const panelId = `code-uses-${t.id}`;
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <div className="text-sm font-medium break-words">{name}</div>
          <p className="text-xs text-muted-foreground">
            <span className={`inline-flex items-center gap-1 font-medium ${status.tone}`}>
              <status.Icon className="size-3.5" aria-hidden="true" /> {status.label}
            </span>
            {" · "}
            {codeDetails(t, now)}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {used > 0 && (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={usesOpen}
              aria-controls={panelId}
              aria-label={`${usesOpen ? "Hide" : "Show"} devices that used ${name}`}
              onClick={onToggleUses}
            >
              {usesOpen ? "Hide uses" : "Uses"}
            </Button>
          )}
          {(t.uses_remaining ?? 0) > 0 && (
            <Button variant="ghost" size="sm" aria-label={`Revoke ${name}`} onClick={onRevoke}>
              Revoke
            </Button>
          )}
        </div>
      </div>
      {usesOpen && (
        <div id={panelId} className="mt-2 rounded-lg bg-background/50 px-3.5 py-3">
          {uses?.loading || !uses ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Loading…
            </p>
          ) : uses.error ? (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <span>Couldn't load the uses. {uses.error}</span>
                <Button variant="outline" size="sm" onClick={onRetryUses}>
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : uses.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No uses recorded.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border/50">
              {uses.rows.map((r) => (
                <li
                  key={`${r.agent_id ?? r.agent_name}-${r.used_at}`}
                  className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0"
                >
                  <span className="text-sm break-words">
                    {r.agent_name}{" "}
                    <span className="text-xs text-muted-foreground">
                      · {new Date(r.used_at).toLocaleString()}
                    </span>
                  </span>
                  {r.agent_id ? (
                    <span className="font-sans text-xs break-all text-muted-foreground">
                      {r.agent_id}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
