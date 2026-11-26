import { Link } from "react-router-dom";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent } from "@vantyr/ui/components/card";
import CountUp from "@/components/react-bits/CountUp";
import { HelpTip } from "@/components/common/HelpTip";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import type { RevisionState } from "@/features/network/runtime/types";

function Revision({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-4xl font-semibold tabular-nums tracking-tight">
        {value === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <>
            r<CountUp to={value} duration={0.8} trigger="load" />
          </>
        )}
      </div>
    </div>
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
    <Card className="gap-0 py-0">
      <CardContent className="flex flex-wrap items-end justify-between gap-6 p-6">
        <div className="flex flex-wrap gap-12">
          <Revision label="Applied by gateways" value={applied} />
          <Revision label="Saved proposal" value={pending ? proposal : null} />
        </div>
        <div className="max-w-md space-y-3 text-sm">
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
      </CardContent>
    </Card>
  );
}
