import { Trash2 } from "lucide-react";
import { Card, CardContent } from "@vantyr/ui/components/card";
import HoldButton from "@/components/react-bits/HoldButton";
import { RuleGroup } from "@/features/devices/components/RuleList";
import { useEditPolicyMutation } from "@/features/network/runtime/useRuntimeQueries";
import type { PolicyRule, PolicySnapshot } from "@/features/network/runtime/types";

const allRules = (s: PolicySnapshot): PolicyRule[] => [
  ...s.baseline,
  ...s.deviceDefaults.flatMap((scope) => scope.rules),
  ...s.personRules.flatMap((scope) => scope.rules),
];

/** The rules a saved proposal adds or removes, and a deliberate way to throw it away. */
export function ProposalCard({
  applied,
  proposal,
}: {
  applied: PolicySnapshot | null;
  proposal: PolicySnapshot;
}) {
  const discard = useEditPolicyMutation();
  const before = new Set(applied ? allRules(applied).map((r) => r.id) : []);
  const after = new Set(allRules(proposal).map((r) => r.id));
  const added = allRules(proposal).filter((r) => !before.has(r.id));
  const removed = applied ? allRules(applied).filter((r) => !after.has(r.id)) : [];

  return (
    <Card className="gap-0 py-0">
      <CardContent className="space-y-6 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="font-medium">Saved proposal r{proposal.revision}</h3>
            <p className="text-sm text-muted-foreground">
              Not enforced. Gateways still use the applied revision.
            </p>
          </div>
          <HoldButton
            icon={<Trash2 className="size-4" />}
            holdTime={900}
            doneLabel="Discarded"
            backgroundColor="var(--muted)"
            textColor="var(--foreground)"
            fillColor="var(--destructive)"
            fillTextColor="var(--foreground)"
            disabled={discard.isPending}
            onHold={() => discard.mutate({ kind: "discard_proposal" })}
          >
            Hold to discard
          </HoldButton>
        </div>
        <RuleGroup title="Would add" rules={added} empty="Adds no rules." />
        <RuleGroup title="Would remove" rules={removed} empty="Removes no rules." />
      </CardContent>
    </Card>
  );
}
