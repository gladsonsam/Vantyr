import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import type { DnsManagementPatchBody } from "@/api/types";
import { networkKeys } from "./network";

export const dnsKeys = {
  root: (household: string) => [...networkKeys.all, household, "dns"] as const,
  management: (household: string) => [...dnsKeys.root(household), "management"] as const,
  status: (household: string) => [...dnsKeys.root(household), "status"] as const,
};

export const dnsQueries = {
  management: (household: string) =>
    queryOptions({
      queryKey: dnsKeys.management(household),
      queryFn: () => api.dnsManagement(household),
    }),
  status: (household: string) =>
    queryOptions({
      queryKey: dnsKeys.status(household),
      queryFn: () => api.dnsStatus(household),
    }),
};

/** Desired DNS config + delivery + supported features. Requires `network_admin`. */
export function useDnsManagement(household: string, opts?: { enabled?: boolean }) {
  return useQuery({ ...dnsQueries.management(household), enabled: opts?.enabled ?? true });
}

/** Reported worker status (`network_admin` or `network_events`). */
export function useDnsStatus(household: string, opts?: { enabled?: boolean }) {
  return useQuery({ ...dnsQueries.status(household), enabled: opts?.enabled ?? true });
}

/** Atomic PATCH of the desired config. Variables are the exact request body. */
export function usePatchDnsManagement(household: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: DnsManagementPatchBody) => api.dnsManagementPatch(household, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: dnsKeys.root(household) }),
  });
}

/** Manual refresh of one list. Variable is the source id. A repeat inside the cooldown resolves with `created: false`. */
export function useRefreshDnsList(household: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) => api.dnsListRefresh(household, sourceId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: dnsKeys.root(household) }),
  });
}
