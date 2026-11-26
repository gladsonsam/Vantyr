import { useState } from "react";
import { History, Undo2 } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vantyr/ui/components/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { errorText, isApiError } from "@/api";
import type { NetworkPolicyVersion } from "@/api/types/network";
import {
  parseReportedRevision,
  usePolicyMutations,
  useSetDesiredPolicyMutation,
  type GatewayStatus,
} from "@/api/queries/network";
import HoldButton from "@/components/react-bits/HoldButton";
import StatusMark, { type StatusMarkStatus } from "@/components/react-bits/StatusMark";
import { HelpTip } from "@/components/common/HelpTip";
import { SettingsSection } from "@/features/network/components/SettingsSection";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { CONFLICT_MESSAGE, formatBytes, shortHash } from "./policyDraft";
import { CompareRevisionDialog, ViewRevisionDialog } from "./PolicyRevisionDialogs";

interface RevisionFacts {
  desiredFor: GatewayStatus[];
  reportedBy: GatewayStatus[];
  failing: boolean;
}

function factsFor(revision: number, statuses: GatewayStatus[]): RevisionFacts {
  const desiredFor = statuses.filter((s) => s.desired?.revision === revision);
  const reportedBy = statuses.filter(
    (s) =>
      s.observation !== null &&
      parseReportedRevision(s.observation.reportedAppliedRevision) === revision,
  );
  const failing = desiredFor.some((s) => s.observation?.reportedFailure);
  return { desiredFor, reportedBy, failing };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The one status line for a revision. "Reported" is the gateway's own, unverified claim. */
function statusFor(f: RevisionFacts): { mark: StatusMarkStatus; text: string } {
  const parts: string[] = [];
  if (f.desiredFor.length > 0) parts.push(`Desired for ${plural(f.desiredFor.length, "gateway")}`);
  if (f.reportedBy.length > 0) {
    parts.push(`Reported applied by ${plural(f.reportedBy.length, "gateway")} (unverified)`);
  }
  if (parts.length === 0) return { mark: "pending", text: "Saved, not assigned to a gateway" };
  if (f.failing) return { mark: "failed", text: `${parts.join(" · ")} · a gateway reports a failure` };
  return { mark: f.reportedBy.length > 0 ? "done" : "running", text: parts.join(" · ") };
}

function conflictAware(error: unknown): string {
  if (isApiError(error) && error.status === 409) return CONFLICT_MESSAGE;
  return errorText(error);
}

function AssignDialog({
  household,
  revision,
  statuses,
  onClose,
}: {
  household: string;
  revision: number;
  statuses: GatewayStatus[];
  onClose: () => void;
}) {
  const assign = useSetDesiredPolicyMutation(household);
  const [gatewayId, setGatewayId] = useState("");
  const choices = statuses.filter((s) => s.gateway.enabled && !s.gateway.revoked_at);
  const chosen = choices.find((s) => s.gateway.id === gatewayId);
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign r{revision} to a gateway</DialogTitle>
          <DialogDescription>
            This records r{revision} as the gateway’s desired revision. The gateway fetches it and
            reports back; nothing is verified.
          </DialogDescription>
        </DialogHeader>
        {choices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active gateway to assign to.</p>
        ) : (
          <div className="space-y-2">
            <Select value={gatewayId} onValueChange={(v) => setGatewayId(v ?? "")}>
              <SelectTrigger aria-label="Gateway" className="w-full">
                <SelectValue placeholder="Choose a gateway" />
              </SelectTrigger>
              <SelectContent>
                {choices.map((s) => (
                  <SelectItem key={s.gateway.id} value={s.gateway.id}>
                    {s.gateway.label} ({s.gateway.kind.toUpperCase()})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {chosen?.desired ? (
              <p className="text-[0.8125rem] text-muted-foreground">
                Replaces r{chosen.desired.revision} as this gateway’s desired revision.
              </p>
            ) : null}
          </div>
        )}
        {assign.isError ? (
          <p role="alert" className="text-[0.8125rem] font-medium text-destructive">
            {conflictAware(assign.error)}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!chosen || assign.isPending}
            onClick={() =>
              assign.mutate({ gateway: gatewayId, revision }, { onSuccess: onClose })
            }
          >
            {assign.isPending ? "Assigning…" : "Assign as desired"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevisionRow({
  version,
  latest,
  facts,
  rollbackBusy,
  onRollback,
  onAssign,
  onView,
  onCompare,
  error,
}: {
  version: NetworkPolicyVersion;
  latest: boolean;
  facts: RevisionFacts;
  rollbackBusy: boolean;
  onRollback: () => void;
  onAssign: () => void;
  onView: () => void;
  onCompare: () => void;
  error: string | null;
}) {
  const status = statusFor(facts);
  return (
    <li className="px-5 py-4">
      <div className="flex items-start gap-4">
        <div className="pt-0.5">
          <StatusMark
            status={status.mark}
            size={22}
            color="var(--muted-foreground)"
            doneColor="var(--success)"
            errorColor="var(--destructive)"
          />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-sm font-semibold">Revision {version.revision}</span>
            {latest ? <span className="text-xs text-muted-foreground">Latest</span> : null}
            {version.rolled_back_from_revision !== null ? (
              <span className="text-xs text-muted-foreground">
                Rolled back from r{version.rolled_back_from_revision}
              </span>
            ) : null}
          </div>
          <div className="text-[0.8125rem] leading-5">{status.text}</div>
          <div className="text-xs text-muted-foreground">
            {version.published_by ?? "Unknown author"} · <TimeAgo iso={version.published_at} /> ·{" "}
            <span className="font-mono" title={version.body_sha256}>
              {shortHash(version.body_sha256)}
            </span>{" "}
            · {formatBytes(version.body_bytes)}
          </div>
          {error ? (
            <p role="alert" className="text-[0.8125rem] font-medium text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onView}>
            View
          </Button>
          <Button variant="outline" size="sm" onClick={onCompare}>
            Compare
          </Button>
          <Button variant="outline" size="sm" onClick={onAssign}>
            Assign to gateway…
          </Button>
          {latest ? null : (
            <HoldButton
              size="sm"
              icon={<Undo2 className="size-4" />}
              holdTime={900}
              glow={false}
              doneLabel="New revision saved"
              backgroundColor="var(--muted)"
              textColor="var(--foreground)"
              fillColor="var(--primary)"
              fillTextColor="var(--primary-foreground)"
              disabled={rollbackBusy}
              ariaLabel={`Hold to roll back to revision ${version.revision}`}
              onHold={onRollback}
            >
              Roll back to this revision
            </HoldButton>
          )}
        </div>
      </div>
    </li>
  );
}

/** Newest first. Rolling back copies an old revision into a NEW one; history is never rewritten. */
export function PolicyHistoryCard({
  household,
  versions,
  statuses,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  household: string;
  versions: NetworkPolicyVersion[];
  statuses: GatewayStatus[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const { rollback } = usePolicyMutations(household);
  const [assigning, setAssigning] = useState<number | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [comparing, setComparing] = useState<number | null>(null);
  const [failed, setFailed] = useState<{ revision: number; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latestRevision = versions[0]?.revision;

  const doRollback = (source: number) => {
    setFailed(null);
    setNotice(null);
    rollback.mutate(
      {
        source_revision: source,
        ...(latestRevision !== undefined ? { expected_revision: latestRevision } : {}),
      },
      {
        onSuccess: (saved) =>
          setNotice(
            `Saved as revision ${saved.revision}, copied from r${source}. It is not assigned to any gateway yet.`,
          ),
        onError: (error) => setFailed({ revision: source, message: conflictAware(error) }),
      },
    );
  };

  return (
    <SettingsSection
      title="History"
      description="Every saved revision, newest first. A revision is a proposal until a gateway is told to use it."
      icon={<History />}
      action={
        <HelpTip label="About rolling back">
          Rolling back never edits or deletes history. It saves a copy of the chosen revision as a
          new revision, which you then assign to gateways. History is bounded; the oldest
          revisions are pruned except ones a gateway still wants.
        </HelpTip>
      }
    >
      {notice ? (
        <p role="status" className="px-5 py-3 text-[0.8125rem] text-success">
          {notice}
        </p>
      ) : null}
      {versions.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          No revisions yet. Compose the first one below.
        </p>
      ) : (
        <ul className="divide-y divide-border/50">
          {versions.map((v) => (
            <RevisionRow
              key={v.revision}
              version={v}
              latest={v.revision === latestRevision}
              facts={factsFor(v.revision, statuses)}
              rollbackBusy={rollback.isPending}
              onRollback={() => doRollback(v.revision)}
              onAssign={() => setAssigning(v.revision)}
              onView={() => setViewing(v.revision)}
              onCompare={() => setComparing(v.revision)}
              error={failed?.revision === v.revision ? failed.message : null}
            />
          ))}
        </ul>
      )}
      {hasMore ? (
        <div className="px-5 py-3">
          <Button variant="outline" size="sm" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
      {viewing !== null ? (
        <ViewRevisionDialog
          household={household}
          revision={viewing}
          onClose={() => setViewing(null)}
        />
      ) : null}
      {comparing !== null ? (
        <CompareRevisionDialog
          household={household}
          revision={comparing}
          versions={versions}
          onClose={() => setComparing(null)}
        />
      ) : null}
      {assigning !== null ? (
        <AssignDialog
          household={household}
          revision={assigning}
          statuses={statuses}
          onClose={() => setAssigning(null)}
        />
      ) : null}
    </SettingsSection>
  );
}
