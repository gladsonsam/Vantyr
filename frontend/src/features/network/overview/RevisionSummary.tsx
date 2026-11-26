import { Link } from "react-router-dom";
import { Button } from "@vantyr/ui/components/button";
import CountUp from "@/components/react-bits/CountUp";
import { HelpTip } from "@/components/common/HelpTip";
import { KeyValueCard, KeyValueGrid } from "@/components/common/resource-detail/KeyValueCard";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import type { RevisionState } from "@/features/network/runtime/types";

function Revision({ label, value }: { label: string; value: number | null }) {
  return (
    <KeyValueCard label={label} format="custom">
      <div className="text-2xl font-semibold tracking-tight tabular-nums">
        {value === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <>
            r<CountUp to={value} duration={0.8} trigger="load" />
          </>
        )}
      </div>
    </KeyValueCard>
  );
}

/**
 * Applied versus saved. Saving a policy never enforces it, so the two are shown as separate numbers
 * and the sentence under them says which one is actually in force.
 */
export function RevisionSummary({ revisions }: { revisions: RevisionState }) {
  const { applied, proposal } = revisions;
  const pending = proposal !== null && (applied === null || proposal > applied);

  let message: string;
  if (applied === null)
    message = "No gateway has applied a policy yet, so nothing is being enforced.";
  else if (pending)
    message = `Gateways are still enforcing revision ${applied}. The saved revision ${proposal} is not in force until they apply it.`;
  else message = `Gateways are enforcing revision ${applied}. There is no pending proposal.`;

  return (
    <div className="space-y-3">
      <KeyValueGrid className="sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-2">
        <Revision label="Applied by gateways" value={applied} />
        <Revision label="Saved proposal" value={pending ? proposal : null} />
      </KeyValueGrid>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-xl border border-border/70 bg-card/10 px-5 py-4 text-sm">
        <div className="min-w-0 space-y-1">
          <p className="flex items-start gap-1.5 text-muted-foreground">
            <span>{message}</span>
            <HelpTip label="About saved and applied">
              Saving a policy only records a proposal. A gateway enforces it after it fetches and
              acknowledges that revision, and that acknowledgement is separate from checking that
              the rules really work.
            </HelpTip>
          </p>
          {pending && revisions.proposalSavedAt ? (
            <p className="text-muted-foreground">
              Saved <TimeAgo iso={revisions.proposalSavedAt} />
            </p>
          ) : null}
        </div>
        {pending ? (
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link to="/network/policies" />}
          >
            Review the proposal
          </Button>
        ) : null}
      </div>
    </div>
  );
}
