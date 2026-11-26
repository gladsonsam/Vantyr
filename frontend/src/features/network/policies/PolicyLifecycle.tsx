import { Route } from "lucide-react";
import { SettingsSection } from "@/features/network/components/SettingsSection";
import StatusMark, { type StatusMarkStatus } from "@/components/react-bits/StatusMark";
import { HelpTip } from "@/components/common/HelpTip";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import type { Gateway, PolicyView } from "@/features/network/runtime/types";

interface Step {
  id: string;
  label: string;
  status: StatusMarkStatus;
  detail: React.ReactNode;
}

/**
 * Saved, applied, verified: three separate facts. Saving a policy only records it, a gateway applying it
 * is a different event, and a check that the rules really work is a third. The marks never skip ahead.
 */
function stepsFor(policy: PolicyView, gateways: Gateway[]): Step[] {
  const pending =
    policy.proposal && (!policy.applied || policy.proposal.revision > policy.applied.revision);
  const subject = pending ? policy.proposal! : policy.applied;
  if (!subject) return [];

  const online = gateways.filter((g) => g.online);
  const verified = gateways.length > 0 && gateways.every((g) => g.verification === "verified");
  const failed = gateways.some((g) => g.verification === "failed");

  return [
    {
      id: "saved",
      label: `Saved r${subject.revision}`,
      status: "done",
      detail: (
        <>
          Recorded <TimeAgo iso={subject.savedAt} />
        </>
      ),
    },
    {
      id: "applied",
      label: "Applied by gateways",
      status: pending ? "pending" : "done",
      detail: pending
        ? online.length === 0
          ? "No gateway is online to fetch it."
          : "Waiting for gateways to fetch and acknowledge this revision."
        : "Acknowledged by the gateways.",
    },
    {
      id: "verified",
      label: "Verified",
      status: pending ? "pending" : failed ? "failed" : verified ? "done" : "pending",
      detail: pending
        ? "Only after it is applied."
        : failed
          ? "A gateway check failed."
          : verified
            ? "A gateway check confirmed the rules work."
            : "Applied, but no gateway has confirmed the rules work yet.",
    },
  ];
}

export function PolicyLifecycle({ policy, gateways }: { policy: PolicyView; gateways: Gateway[] }) {
  const steps = stepsFor(policy, gateways);
  if (steps.length === 0) return null;
  return (
    <SettingsSection
      title="Where this policy stands"
      description="Saved, applied and verified are three separate facts."
      icon={<Route />}
      action={
        <HelpTip label="About saved, applied and verified">
          Saving only records a proposal. A gateway enforces it once it fetches and acknowledges
          that revision, and that is separate from confirming the rules really work.
        </HelpTip>
      }
    >
      <ol className="divide-y divide-border/50">
        {steps.map((step, index) => (
          <li key={step.id} className="flex items-start gap-4 px-5 py-4">
            <div className="flex flex-col items-center">
              <StatusMark
                status={step.status}
                size={22}
                color="var(--muted-foreground)"
                doneColor="var(--success)"
                errorColor="var(--destructive)"
              />
            </div>
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold">{step.label}</div>
                <span className="text-xs text-muted-foreground tabular-nums">
                  Step {index + 1} of {steps.length}
                </span>
              </div>
              <div className="text-[0.8125rem] leading-5 text-muted-foreground">{step.detail}</div>
            </div>
          </li>
        ))}
      </ol>
    </SettingsSection>
  );
}
