import { useState } from "react";
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
import { Spinner } from "@vantyr/ui/components/spinner";
import type { NetworkPolicyVersion } from "@/api/types/network";
import { usePolicyDiff, usePolicyRevision } from "@/api/queries/network";
import { PolicyBodyView, PolicyDiffView } from "./policyView";
import { readError } from "./policyViewLib";

const CONTENT = "max-h-[85vh] overflow-y-auto sm:max-w-2xl";

function Loading() {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
      <Spinner /> Loading…
    </div>
  );
}

function ReadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="space-y-2">
      <p role="alert" className="text-sm font-medium text-destructive">
        {message}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** Read-only view of one stored revision, listed or not. */
export function ViewRevisionDialog({
  household,
  revision,
  onClose,
}: {
  household: string;
  revision: number;
  onClose: () => void;
}) {
  const query = usePolicyRevision(household, revision);
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className={CONTENT}>
        <DialogHeader>
          <DialogTitle>Revision {revision}</DialogTitle>
          <DialogDescription>
            A saved proposal. It says nothing about what any gateway has applied.
          </DialogDescription>
        </DialogHeader>
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <ReadFailed message={readError(query.error)} onRetry={() => void query.refetch()} />
        ) : (
          <PolicyBodyView view={query.data.policy} />
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Semantic comparison of `revision` with another listed revision (default: the previous one). */
export function CompareRevisionDialog({
  household,
  revision,
  versions,
  onClose,
}: {
  household: string;
  revision: number;
  /** Listed revisions, newest first. */
  versions: NetworkPolicyVersion[];
  onClose: () => void;
}) {
  const latest = versions[0]?.revision;
  const others = versions.map((v) => v.revision).filter((r) => r !== revision);
  const previous = others.find((r) => r < revision) ?? others[others.length - 1] ?? null;
  const [other, setOther] = useState<number | null>(previous);
  // The older revision is always "from"; the newer is "to".
  const from = other === null ? null : Math.min(other, revision);
  const to = other === null ? null : Math.max(other, revision);
  const diff = usePolicyDiff(household, from, to);

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className={CONTENT}>
        <DialogHeader>
          <DialogTitle>Compare r{revision}</DialogTitle>
          <DialogDescription>
            A readable summary of what differs between two saved revisions. It is not a patch and
            changes nothing.
          </DialogDescription>
        </DialogHeader>
        {others.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            There is no other listed revision to compare with.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Compare with</span>
            <Select
              value={other === null ? "" : String(other)}
              onValueChange={(v) => setOther(v ? Number(v) : null)}
            >
              <SelectTrigger aria-label="Revision to compare with" className="w-40">
                <SelectValue placeholder="Choose a revision" />
              </SelectTrigger>
              <SelectContent>
                {others.map((r) => (
                  <SelectItem key={r} value={String(r)}>
                    r{r}
                    {r === latest ? " (current)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {latest !== undefined && latest !== revision && other !== latest ? (
              <Button variant="outline" size="sm" onClick={() => setOther(latest)}>
                Compare with current (r{latest})
              </Button>
            ) : null}
          </div>
        )}
        {other === null ? null : diff.isPending ? (
          <Loading />
        ) : diff.isError ? (
          <ReadFailed
            message={readError(diff.error, "comparison")}
            onRetry={() => void diff.refetch()}
          />
        ) : (
          <PolicyDiffView diff={diff.data.diff} />
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
