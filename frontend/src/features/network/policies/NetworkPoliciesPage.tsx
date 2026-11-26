import { ShieldCheck } from "lucide-react";
import { SettingsSection } from "@/features/network/components/SettingsSection";
import { Spinner } from "@vantyr/ui/components/spinner";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import { RuleGroup } from "@/features/devices/components/RuleList";
import { UnavailableSection } from "@/features/network/components/AvailabilityGate";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { matchText } from "@/features/devices/lib/format";
import { useOverviewQuery, usePolicyQuery } from "@/features/network/runtime/useRuntimeQueries";
import type { ScopedRules } from "@/features/network/runtime/types";
import { PolicyLifecycle } from "./PolicyLifecycle";
import { ProposalCard } from "./ProposalCard";

function Scoped({ title, scopes }: { title: string; scopes: ScopedRules[] }) {
  return (
    <div className="space-y-4">
      <h4 className="text-sm font-medium">{title}</h4>
      {scopes.map((scope) => (
        <RuleGroup key={scope.scopeId} title={scope.label} rules={scope.rules} empty="No rules." />
      ))}
    </div>
  );
}

/** The policy that is in force, what is waiting to be, and where each stands. */
export function NetworkPoliciesPage() {
  const policy = usePolicyQuery();
  const overview = useOverviewQuery();

  if (policy.isPending || overview.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl bg-card py-12 text-sm text-muted-foreground">
        <Spinner /> Loading…
      </div>
    );
  }
  if (policy.isError) {
    return (
      <LoadFailedCard message="Couldn’t load the policy." onRetry={() => void policy.refetch()} />
    );
  }
  if (policy.data.state === "unavailable") {
    return <UnavailableSection title="Policies" reason={policy.data.reason} />;
  }
  const { applied, proposal } = policy.data.data;
  const gateways = overview.data?.state === "ready" ? overview.data.data.gateways : [];
  const pending = proposal && (!applied || proposal.revision > applied.revision);

  return (
    <div className="space-y-6">
      <PolicyLifecycle policy={policy.data.data} gateways={gateways} />
      {pending ? <ProposalCard applied={applied} proposal={proposal} /> : null}
      {applied ? (
        <SettingsSection
          title={`In force: revision ${applied.revision}`}
          icon={<ShieldCheck />}
          action={
            <span className="text-xs text-muted-foreground">
              Saved <TimeAgo iso={applied.savedAt} /> · {applied.timezone}
            </span>
          }
          bodyClassName="divide-y-0 space-y-8 py-5"
        >
            <RuleGroup
              title="Household baseline"
              rules={applied.baseline}
              empty="No baseline rules."
            />
            <Scoped title="Device defaults" scopes={applied.deviceDefaults} />
            <Scoped title="People (when verified)" scopes={applied.personRules} />
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Exceptions</h4>
              {applied.exceptions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No exceptions.</p>
              ) : (
                <ul className="divide-y divide-border/50">
                  {applied.exceptions.map((exception) => (
                    <li
                      key={exception.id}
                      className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3 text-sm"
                    >
                      <span>
                        <span className="font-medium">{exception.scopeLabel}</span>{" "}
                        <span className="font-mono text-[0.8125rem]">
                          {matchText(exception.match)}
                        </span>
                      </span>
                      <span className="text-muted-foreground">
                        {exception.reason} · approved by {exception.approvedBy} · expires{" "}
                        <TimeAgo iso={exception.expiresAt} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              Anything else is {applied.defaultEffect === "allow" ? "allowed" : "blocked"} by the
              household default. If the server is unreachable a gateway keeps its last policy for{" "}
              {Math.round(applied.staleAfterSeconds / 60)} minutes.
            </p>
        </SettingsSection>
      ) : null}
    </div>
  );
}
