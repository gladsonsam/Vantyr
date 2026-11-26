import { FileClock, Trash2 } from "lucide-react";
import { SettingsCardBody, SettingsSection } from "@/features/network/components/SettingsSection";
import { HelpTip } from "@/components/common/HelpTip";
import HoldButton from "@/components/react-bits/HoldButton";
import { RuleGroup } from "@/features/devices/components/RuleList";
import { useEditPolicyMutation } from "@/features/network/runtime/useRuntimeQueries";
import type { PolicyRule, PolicySnapshot } from "@/features/network/runtime/types";

const allRules = (s: PolicySnapshot): PolicyRule[] => [
  ...s.baseline,
  ...s.deviceDefaults.flatMap((scope) => scope.rules),
  ...s.personRules.flatMap((scope) => scope.rules),
];

/**
 * The rules a saved proposal adds or removes. "Saved" means a stored, immutable policy revision; the real
 * product has no draft or discard endpoint, and discarding only applies to an unsaved local composer
 * draft. The hold-to-discard below exists for the demo only and is labelled so.
 */
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
    <SettingsSection
      title={`Saved proposal r${proposal.revision}`}
      description="Saved revisions are stored and can’t be deleted. Not enforced: gateways still use the applied revision."
      icon={<FileClock />}
      action={
        <div className="flex items-center gap-2">
          <HelpTip label="About discarding">
            Demo only. In the real product a saved revision is permanent history and can’t be
            discarded; only an unsaved draft in the composer can be thrown away.
          </HelpTip>
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
            Demo only: hold to discard
          </HoldButton>
        </div>
      }
    >
      <SettingsCardBody>
        <RuleGroup title="Would add" rules={added} empty="Adds no rules." />
        <RuleGroup title="Would remove" rules={removed} empty="Removes no rules." />
      </SettingsCardBody>
    </SettingsSection>
  );
}
