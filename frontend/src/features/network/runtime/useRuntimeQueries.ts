import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { networkKeys } from "@/api/queries/network";
import { useNetworkRuntime } from "./NetworkRuntimeSource";
import type { DecisionQuery, DnsStatsQuery, EventsQuery, PolicyEdit } from "./types";

const runtimeKey = (...parts: unknown[]) => [...networkKeys.all, "runtime", ...parts] as const;

/** Gateway and policy state changes on its own, so these refresh in the background. */
const LIVE_REFETCH_MS = 15_000;

export function useOverviewQuery() {
  const runtime = useNetworkRuntime();
  return useQuery({
    queryKey: runtimeKey("overview"),
    queryFn: () => runtime.overview(),
    refetchInterval: LIVE_REFETCH_MS,
  });
}

export function usePolicyQuery() {
  const runtime = useNetworkRuntime();
  return useQuery({ queryKey: runtimeKey("policy"), queryFn: () => runtime.policy() });
}

export function useEditPolicyMutation() {
  const runtime = useNetworkRuntime();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (edit: PolicyEdit) => runtime.editPolicy(edit),
    // The saved proposal also moves the overview's "applied vs saved" comparison.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: runtimeKey() }),
  });
}

export function useExplainDecisionMutation() {
  const runtime = useNetworkRuntime();
  return useMutation({ mutationFn: (query: DecisionQuery) => runtime.explainDecision(query) });
}

export function useDnsQuery() {
  const runtime = useNetworkRuntime();
  return useQuery({ queryKey: runtimeKey("dns"), queryFn: () => runtime.dns() });
}

export function useDnsStatsQuery(query: DnsStatsQuery) {
  const runtime = useNetworkRuntime();
  return useQuery({
    queryKey: runtimeKey("dns-stats", query),
    queryFn: () => runtime.dnsStats(query),
  });
}

export function useProxyQuery() {
  const runtime = useNetworkRuntime();
  return useQuery({ queryKey: runtimeKey("proxy"), queryFn: () => runtime.proxy() });
}

export function useEventsQuery(query: EventsQuery) {
  const runtime = useNetworkRuntime();
  return useQuery({
    queryKey: runtimeKey("events", query),
    queryFn: () => runtime.events(query),
  });
}
