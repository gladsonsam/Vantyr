import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { isApiError } from "@/api";
import { networkQueries, useGatewayStatuses } from "@/api/queries/network";
import { useNetworkHousehold } from "@/features/network/access/networkScope";
import { SettingsPageHeader } from "@/features/settings/components/SettingsLayout";
import { SettingsCardBody, SettingsSection } from "@/features/network/components/SettingsSection";
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
import { GatewayAssignmentsStrip } from "./GatewayAssignmentsStrip";
import { PolicyHistoryCard } from "./PolicyHistoryCard";
import { PolicyComposer } from "./PolicyComposer";

const PAGE_SIZE = 10;

/**
 * Real revision lifecycle from the server: history, per-gateway desired/reported, and a composer.
 * It is independent of the runtime view below, which may be unavailable on a real server.
 */
function RevisionLifecycle() {
  const household = useNetworkHousehold();
  const runtimePolicy = usePolicyQuery();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const policies = useQuery({
    ...networkQueries.policies(household.id, { limit }),
    placeholderData: keepPreviousData,
  });
  const gateways = useGatewayStatuses(household.id);

  if (policies.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-border/70 bg-card/10 py-12 text-sm text-muted-foreground">
        <Spinner /> Loading…
      </div>
    );
  }
  if (policies.isError) {
    const error = policies.error;
    if (isApiError(error) && error.status === 404) {
      return (
        <UnavailableSection
          title="Policy revisions"
          reason="This server has no policy revision API yet."
        />
      );
    }
    if (isApiError(error) && error.status === 403) {
      return (
        <UnavailableSection
          title="Policy revisions"
          reason="You don’t have permission to manage policy for this household."
        />
      );
    }
    return (
      <LoadFailedCard
        message="Couldn’t load the policy history."
        onRetry={() => void policies.refetch()}
      />
    );
  }

  const versions = [...policies.data.policies].sort((a, b) => b.revision - a.revision);
  const runtime = runtimePolicy.data?.state === "ready" ? runtimePolicy.data.data : null;
  return (
    <>
      <GatewayAssignmentsStrip
        statuses={gateways.statuses}
        isPending={gateways.isPending}
        isError={gateways.isError}
      />
      <PolicyHistoryCard
        household={household.id}
        versions={versions}
        statuses={gateways.statuses}
        hasMore={versions.length >= limit}
        loadingMore={policies.isFetching}
        onLoadMore={() => setLimit((n) => n + PAGE_SIZE)}
      />
      <PolicyComposer
        household={household.id}
        timezone={household.timezone}
        latest={versions[0]}
        runtimeStart={runtime ? (runtime.proposal ?? runtime.applied) : null}
      />
    </>
  );
}

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

  return (
    <div className="space-y-8">
      <SettingsPageHeader
        title="Policies"
        description="Revisions are saved first, assigned to gateways second, and only reported back by them. None of it is verified."
      />
      <RevisionLifecycle />
      <RuntimePolicy policy={policy} overview={overview} />
    </div>
  );
}

function RuntimePolicy({
  policy,
  overview,
}: {
  policy: ReturnType<typeof usePolicyQuery>;
  overview: ReturnType<typeof useOverviewQuery>;
}) {
  if (policy.isPending || overview.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-border/70 bg-card/10 py-12 text-sm text-muted-foreground">
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
    return <UnavailableSection title="Policy in force" reason={policy.data.reason} />;
  }
  const { applied, proposal } = policy.data.data;
  const gateways = overview.data?.state === "ready" ? overview.data.data.gateways : [];
  const pending = proposal && (!applied || proposal.revision > applied.revision);

  return (
    <div className="space-y-8">
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
        >
          <SettingsCardBody className="space-y-8">
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
                <ul className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/70">
                  {applied.exceptions.map((exception) => (
                    <li
                      key={exception.id}
                      className="flex items-start gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/40"
                    >
                      <span
                        className="mt-2 size-1.5 shrink-0 rounded-full bg-warning"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                          <span>
                            <span className="font-medium">{exception.scopeLabel}</span>{" "}
                            <span className="font-mono text-[0.8125rem]">
                              {matchText(exception.match)}
                            </span>
                          </span>
                          <span className="text-xs text-muted-foreground">
                            expires <TimeAgo iso={exception.expiresAt} />
                          </span>
                        </div>
                        <div className="text-[0.8125rem] text-muted-foreground">
                          {exception.reason} · approved by {exception.approvedBy}
                        </div>
                      </div>
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
          </SettingsCardBody>
        </SettingsSection>
      ) : null}
    </div>
  );
}
