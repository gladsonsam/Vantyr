import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { networkKeys } from "@/api/queries/network";
import { useNetworkRuntime } from "./NetworkRuntimeSource";
import type {
  DecisionQuery,
  DnsSettingsPatch,
  DnsStatsQuery,
  EventsQuery,
  IssueProxyCredentialInput,
  PolicyEdit,
  ProxyStatsQuery,
} from "./types";

/** Keys always carry the runtime's scope (source kind + household): see NetworkRuntimeSource.scope. */
const runtimeKey = (scope: string, ...parts: unknown[]) =>
  [...networkKeys.all, "runtime", scope, ...parts] as const;

/** Placeholder data may only carry over within one scope, never across households or sources. */
export function keepPreviousWithinScope<T>(scope: string) {
  return (previous: T | undefined, previousQuery?: { queryKey: readonly unknown[] }) =>
    previousQuery && previousQuery.queryKey[2] === scope ? previous : undefined;
}

/** Gateway and policy state changes on its own, so these refresh in the background. */
const LIVE_REFETCH_MS = 15_000;

export function useOverviewQuery() {
  const runtime = useNetworkRuntime();
  return useQuery({
    queryKey: runtimeKey(runtime.scope, "overview"),
    queryFn: () => runtime.overview(),
    refetchInterval: LIVE_REFETCH_MS,
  });
}

export function usePolicyQuery() {
  const runtime = useNetworkRuntime();
  return useQuery({
    queryKey: runtimeKey(runtime.scope, "policy"),
    queryFn: () => runtime.policy(),
  });
}

export function useEditPolicyMutation() {
  const runtime = useNetworkRuntime();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (edit: PolicyEdit) => runtime.editPolicy(edit),
    // The saved proposal also moves the overview's "applied vs saved" comparison.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: runtimeKey(runtime.scope) }),
  });
}

export function useExplainDecisionMutation() {
  const runtime = useNetworkRuntime();
  return useMutation({ mutationFn: (query: DecisionQuery) => runtime.explainDecision(query) });
}

export function useDnsQuery() {
  const runtime = useNetworkRuntime();
  return useQuery({ queryKey: runtimeKey(runtime.scope, "dns"), queryFn: () => runtime.dns() });
}

export function useDnsStatsQuery(query: DnsStatsQuery) {
  const runtime = useNetworkRuntime();
  return useQuery({
    queryKey: runtimeKey(runtime.scope, "dns-stats", query),
    queryFn: () => runtime.dnsStats(query),
  });
}

export function useProxyStatsQuery(query: ProxyStatsQuery) {
  const runtime = useNetworkRuntime();
  return useQuery({
    queryKey: runtimeKey(runtime.scope, "proxy-stats", query),
    queryFn: () => runtime.proxyStats(query),
  });
}

export function useProxyQuery() {
  const runtime = useNetworkRuntime();
  return useQuery({ queryKey: runtimeKey(runtime.scope, "proxy"), queryFn: () => runtime.proxy() });
}

export function useEventsQuery(query: EventsQuery) {
  const runtime = useNetworkRuntime();
  return useQuery({
    queryKey: runtimeKey(runtime.scope, "events", query),
    queryFn: () => runtime.events(query),
  });
}

export function useUpdateDnsMutation() {
  const runtime = useNetworkRuntime();
  const queryClient = useQueryClient();
  return useMutation({
    // Pass `expectedSettingsVersion` for a compare-and-set write; a stale one rejects with RuntimeConflictError.
    mutationFn: ({
      expectedSettingsVersion,
      ...patch
    }: DnsSettingsPatch & { expectedSettingsVersion?: number }) =>
      runtime.updateDns(patch, { expectedSettingsVersion }),
    // Also on error: after a conflict the screen needs the newer settings.
    onSettled: () => queryClient.invalidateQueries({ queryKey: runtimeKey(runtime.scope, "dns") }),
  });
}

export function useClearDnsCacheMutation() {
  const runtime = useNetworkRuntime();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => runtime.clearDnsCache(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: runtimeKey(runtime.scope, "dns") }),
  });
}

export function useProxyAccessQuery() {
  const runtime = useNetworkRuntime();
  return useQuery({
    // Nested under "proxy" so proxy mutations refresh it too.
    queryKey: runtimeKey(runtime.scope, "proxy", "access"),
    queryFn: () => runtime.proxyAccess(),
  });
}

export function useIssueProxyCredentialMutation() {
  const runtime = useNetworkRuntime();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: IssueProxyCredentialInput) => runtime.issueProxyCredential(input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: runtimeKey(runtime.scope, "proxy") }),
  });
}

export function useEndProxySessionMutation() {
  const runtime = useNetworkRuntime();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => runtime.endProxySession(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: runtimeKey(runtime.scope, "proxy") }),
  });
}

export function useRevokeAllForPersonMutation() {
  const runtime = useNetworkRuntime();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (personId: string) => runtime.revokeAllForPerson(personId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: runtimeKey(runtime.scope, "proxy") }),
  });
}

export function useRevokeCredentialMutation() {
  const runtime = useNetworkRuntime();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => runtime.revokeProxyCredential(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: runtimeKey(runtime.scope, "proxy") }),
  });
}

export function useSetInspectionMutation() {
  const runtime = useNetworkRuntime();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => runtime.setInspection(enabled),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: runtimeKey(runtime.scope, "proxy") }),
  });
}

export function useRunCheckMutation() {
  const runtime = useNetworkRuntime();
  return useMutation({
    mutationFn: ({ deviceId, kind }: { deviceId: string; kind: "dns" | "proxy" }) =>
      runtime.runCheck(deviceId, kind),
  });
}
