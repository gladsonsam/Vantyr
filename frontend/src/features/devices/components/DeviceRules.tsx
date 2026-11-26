import { useState } from "react";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { HelpTip } from "@/components/common/HelpTip";
import { DetailSection } from "@/components/common/resource-detail/DetailSection";
import StatusMark from "@/components/react-bits/StatusMark";
import { UnavailableSection } from "@/features/network/components/AvailabilityGate";
import { usePolicyQuery } from "@/features/network/runtime/useRuntimeQueries";
import { OverviewCard } from "./OverviewCard";
import { RuleGroup } from "./RuleList";

/**
 * The rules that apply to this device before anyone is verified on it: the household baseline, then the
 * device's own defaults. Person rules join in only when a person is verified.
 */
export function DeviceRules({
  deviceId,
  summary = false,
  personIds = [],
  className,
}: {
  deviceId: string;
  /** Counts and the one-line note, with the full list behind "Show rules". */
  summary?: boolean;
  /** The people assigned to this device, so their rules can be counted. */
  personIds?: string[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const query = usePolicyQuery();
  if (query.isPending) return null;
  if (query.isError) {
    return <UnavailableSection title="Rules in effect" reason="Couldn’t load the rules." />;
  }
  if (query.data.state === "unavailable") {
    return <UnavailableSection title="Rules in effect" reason={query.data.reason} />;
  }
  const applied = query.data.data.applied;
  if (!applied) {
    return (
      <UnavailableSection
        title="Rules in effect"
        reason="No policy has been applied yet, so nothing is being enforced for this device."
      />
    );
  }
  const deviceRules = applied.deviceDefaults.find((s) => s.scopeId === deviceId)?.rules ?? [];
  const proposal = query.data.data.proposal;
  const waiting = proposal && proposal.revision > applied.revision ? proposal : null;
  if (summary) {
    const personCount = applied.personRules
      .filter((s) => personIds.includes(s.scopeId))
      .reduce((n, s) => n + s.rules.length, 0);
    return (
      <OverviewCard
        title="Rules in effect"
        help={
          <HelpTip label="About rules">
            Anything else is {applied.defaultEffect === "allow" ? "allowed" : "blocked"} by the
            household default. A person’s own rules apply only once they are verified on the
            device.
          </HelpTip>
        }
        className={className}
      >
        <p className="text-base">
          {applied.baseline.length} baseline · {deviceRules.length} device · {personCount} person
        </p>
        {waiting ? (
          <p className="flex items-center gap-2 text-base text-muted-foreground">
            <StatusMark status="pending" size={16} color="var(--muted-foreground)" />
            Revision {waiting.revision} is saved but not applied.
          </p>
        ) : null}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-9 w-fit items-center gap-1 rounded-md text-base text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {open ? "Hide rules" : "Show rules"}
          <ChevronDown className={open ? "size-4 rotate-180" : "size-4"} />
        </button>
        {open ? (
          <div className="space-y-6">
            <RuleGroup
              title="Household baseline"
              rules={applied.baseline}
              empty="No baseline rules."
            />
            <RuleGroup
              title="This device’s defaults"
              rules={deviceRules}
              empty="No rules of its own."
            />
          </div>
        ) : null}
      </OverviewCard>
    );
  }
  return (
    <DetailSection
      title="Rules in effect"
      icon={ShieldCheck}
      action={<span className="text-sm text-muted-foreground">Revision {applied.revision}</span>}
    >
      {waiting ? (
        <div className="flex items-start gap-3 rounded-xl border border-border/70 p-3 text-sm">
          <StatusMark status="pending" size={20} color="var(--muted-foreground)" />
          <span className="text-muted-foreground">
            Revision {waiting.revision} is saved but not applied. It changes nothing for this
            device until the gateways apply it.
          </span>
        </div>
      ) : null}
      <div className="space-y-6 rounded-xl border border-border/70 bg-card/10 p-5">
        <RuleGroup title="Household baseline" rules={applied.baseline} empty="No baseline rules." />
        <RuleGroup
          title="This device’s defaults"
          rules={deviceRules}
          empty="No rules of its own."
        />
      </div>
      <p className="text-sm text-muted-foreground">
        Anything else is {applied.defaultEffect === "allow" ? "allowed" : "blocked"} by the
        household default. A person’s own rules apply only once they are verified on the device.
      </p>
    </DetailSection>
  );
}
