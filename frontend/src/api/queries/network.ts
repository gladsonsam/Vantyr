import {
  keepPreviousData,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "@/api";
import type {
  NetworkAuditFilters,
  NetworkDesiredPolicy,
  NetworkGateway,
  NetworkGatewayKind,
  NetworkGatewayReport,
  NetworkPageParams,
  NetworkSetupGrantConsume,
  NetworkVerifiedSession,
} from "@/api/types";

/** Everything Vantyr Network sits under `networkKeys.all`; every key below it is household-scoped. */
export const networkKeys = {
  all: ["network"] as const,
  households: () => [...networkKeys.all, "households"] as const,
  inventory: (household: string) =>
    [...networkKeys.all, household, "inventory"] as const,
  persons: (household: string) =>
    [...networkKeys.inventory(household), "persons"] as const,
  devices: (household: string) =>
    [...networkKeys.inventory(household), "devices"] as const,
  assignments: (household: string) =>
    [...networkKeys.inventory(household), "assignments"] as const,
  connections: (household: string) =>
    [...networkKeys.inventory(household), "connections"] as const,
  enrollments: (household: string) =>
    [...networkKeys.inventory(household), "enrollments"] as const,
  grants: (household: string) =>
    [...networkKeys.all, household, "grants"] as const,
  audit: (household: string, filters?: NetworkAuditFilters) =>
    [...networkKeys.all, household, "audit", filters ?? {}] as const,
  policyCurrent: (household: string) =>
    [...networkKeys.policiesRoot(household), "current"] as const,
  policyRevision: (household: string, revision: number) =>
    [...networkKeys.policiesRoot(household), "revision", revision] as const,
  policyDiff: (household: string, from: number, to: number) =>
    [...networkKeys.policiesRoot(household), "diff", from, to] as const,
  enrollmentContexts: (page?: NetworkPageParams) =>
    [...networkKeys.all, "enrollment-contexts", page ?? {}] as const,
  gatewaysRoot: (household: string) =>
    [...networkKeys.all, household, "gateways"] as const,
  gateways: (household: string, kind?: NetworkGatewayKind) =>
    [...networkKeys.gatewaysRoot(household), "list", kind ?? "all"] as const,
  gatewayCredentials: (household: string, gateway: string) =>
    [...networkKeys.gatewaysRoot(household), gateway, "credentials"] as const,
  gatewayReports: (
    household: string,
    gateway: string,
    page?: NetworkPageParams,
  ) =>
    [
      ...networkKeys.gatewaysRoot(household),
      gateway,
      "reports",
      page ?? {},
    ] as const,
  gatewayDesired: (household: string, gateway: string) =>
    [...networkKeys.gatewaysRoot(household), gateway, "desired"] as const,
  policies: (household: string, page?: NetworkPageParams) =>
    [...networkKeys.all, household, "policies", page ?? {}] as const,
  policiesRoot: (household: string) =>
    [...networkKeys.all, household, "policies"] as const,
  // BYOD
  bindings: (household: string) =>
    [...networkKeys.all, household, "bindings"] as const,
  deviceAuthorizations: (household: string, binding: string) =>
    [...networkKeys.bindings(household), binding, "device-authorizations"] as const,
  enrollRoot: (household: string) =>
    [...networkKeys.all, household, "enroll"] as const,
  ownDevices: (household: string) =>
    [...networkKeys.enrollRoot(household), "devices"] as const,
  ownGrants: (household: string) =>
    [...networkKeys.enrollRoot(household), "grants"] as const,
  ownSessions: (household: string) =>
    [...networkKeys.enrollRoot(household), "sessions"] as const,
};

/** Rows per page of the device-authorization list. */
export const DEVICE_AUTHORIZATION_PAGE = 25;

export const networkQueries = {
  households: () =>
    queryOptions({
      queryKey: networkKeys.households(),
      queryFn: () => api.networkHouseholds(),
      // A 403/404 here means "no access" or "not built in": retrying only delays the answer.
      retry: false,
      staleTime: 60_000,
    }),
  persons: (household: string) =>
    queryOptions({
      queryKey: networkKeys.persons(household),
      queryFn: () => api.networkPersons(household),
    }),
  devices: (household: string) =>
    queryOptions({
      queryKey: networkKeys.devices(household),
      queryFn: () => api.networkDevices(household),
    }),
  assignments: (household: string) =>
    queryOptions({
      queryKey: networkKeys.assignments(household),
      queryFn: () => api.networkAssignments(household),
    }),
  connections: (household: string) =>
    queryOptions({
      queryKey: networkKeys.connections(household),
      queryFn: () => api.networkConnections(household),
    }),
  enrollments: (household: string) =>
    queryOptions({
      queryKey: networkKeys.enrollments(household),
      queryFn: () => api.networkAgentEnrollments(household),
    }),
  grants: (household: string) =>
    queryOptions({
      queryKey: networkKeys.grants(household),
      queryFn: () => api.networkGrants(household),
    }),
  audit: (household: string, filters?: NetworkAuditFilters) =>
    queryOptions({
      queryKey: networkKeys.audit(household, filters),
      queryFn: () => api.networkAudit(household, filters),
    }),
  policyCurrent: (household: string) =>
    queryOptions({
      queryKey: networkKeys.policyCurrent(household),
      queryFn: () => api.networkPolicyCurrent(household),
    }),
  policyRevision: (household: string, revision: number) =>
    queryOptions({
      queryKey: networkKeys.policyRevision(household, revision),
      queryFn: () => api.networkPolicyRevision(household, revision),
      // A stored revision is immutable; a 404 (pruned/foreign) is an answer, not a glitch.
      staleTime: 5 * 60_000,
      retry: false,
    }),
  policyDiff: (household: string, from: number, to: number) =>
    queryOptions({
      queryKey: networkKeys.policyDiff(household, from, to),
      queryFn: () => api.networkPolicyDiff(household, from, to),
      staleTime: 5 * 60_000,
      retry: false,
    }),
  enrollmentContexts: (page?: NetworkPageParams) =>
    queryOptions({
      queryKey: networkKeys.enrollmentContexts(page),
      queryFn: () => api.networkEnrollmentContexts(page),
      // Current-user scoped: 401/empty is an answer.
      retry: false,
    }),
  gateways: (household: string, kind?: NetworkGatewayKind) =>
    queryOptions({
      queryKey: networkKeys.gateways(household, kind),
      queryFn: () =>
        api.networkGateways(household, kind ? { kind } : undefined),
    }),
  gatewayCredentials: (household: string, gateway: string) =>
    queryOptions({
      queryKey: networkKeys.gatewayCredentials(household, gateway),
      queryFn: () => api.networkGatewayCredentials(household, gateway),
    }),
  gatewayReports: (
    household: string,
    gateway: string,
    page?: NetworkPageParams,
  ) =>
    queryOptions({
      queryKey: networkKeys.gatewayReports(household, gateway, page),
      queryFn: () => api.networkGatewayReports(household, gateway, page),
    }),
  gatewayDesired: (household: string, gateway: string) =>
    queryOptions({
      queryKey: networkKeys.gatewayDesired(household, gateway),
      queryFn: () => api.networkGatewayDesiredPolicy(household, gateway),
    }),
  policies: (household: string, page?: NetworkPageParams) =>
    queryOptions({
      queryKey: networkKeys.policies(household, page),
      queryFn: () => api.networkPolicies(household, page),
    }),
  bindings: (household: string) =>
    queryOptions({
      queryKey: networkKeys.bindings(household),
      queryFn: () => api.networkBindings(household),
    }),
  // The enroll reads are person-scoped: a 403/404 is an answer ("no BYOD here"), not a glitch.
  ownDevices: (household: string) =>
    queryOptions({
      queryKey: networkKeys.ownDevices(household),
      queryFn: () => api.networkOwnDevices(household),
      retry: false,
    }),
  ownGrants: (household: string) =>
    queryOptions({
      queryKey: networkKeys.ownGrants(household),
      queryFn: () => api.networkOwnGrants(household),
      retry: false,
    }),
  ownSessions: (household: string) =>
    queryOptions({
      queryKey: networkKeys.ownSessions(household),
      queryFn: () => api.networkOwnSessions(household),
      retry: false,
    }),
};

export { policyToDraft, type DroppedPolicyContent } from "./networkPolicyDraft";

/** Highest stored revision (network_admin). Not the desired, applied or verified one. */
export function usePolicyCurrent(household: string, enabled = true) {
  return useQuery({ ...networkQueries.policyCurrent(household), enabled });
}

/** One stored revision; idle while `revision` is null. */
export function usePolicyRevision(household: string, revision: number | null) {
  return useQuery({
    ...networkQueries.policyRevision(household, revision ?? 0),
    enabled: revision != null && revision >= 1,
  });
}

/** Diff between two stored revisions; idle until both are set. */
export function usePolicyDiff(
  household: string,
  from: number | null,
  to: number | null,
) {
  return useQuery({
    ...networkQueries.policyDiff(household, from ?? 0, to ?? 0),
    enabled: from != null && to != null && from >= 1 && to >= 1,
  });
}

/** One audit page for the given exact-match filters. Keeps the previous page while paging. */
export function useAudit(household: string, filters?: NetworkAuditFilters) {
  return useQuery({
    ...networkQueries.audit(household, filters),
    placeholderData: keepPreviousData,
  });
}

/** Households and people the signed-in user is bound to (for self-service enrollment). */
export function useEnrollmentContexts(page?: NetworkPageParams) {
  return useQuery(networkQueries.enrollmentContexts(page));
}

export function useBindings(household: string) {
  return useQuery(networkQueries.bindings(household));
}

/** Add and revoke principal bindings. Revoking also drops everything that hung off the binding. */
export function useBindingMutations(household: string) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: networkKeys.bindings(household) });
  return {
    create: useMutation({
      mutationFn: (body: { person_id: string; user_id: string }) =>
        api.networkBindingCreate(household, body),
      onSuccess: invalidate,
    }),
    revoke: useMutation({
      mutationFn: (binding: string) => api.networkBindingDelete(household, binding),
      onSuccess: () =>
        Promise.all([
          invalidate(),
          queryClient.invalidateQueries({ queryKey: networkKeys.enrollRoot(household) }),
        ]),
    }),
  };
}

/** Pages of one binding's device authorizations, loaded on demand with `fetchNextPage`. */
export function useDeviceAuthorizations(
  household: string,
  binding: string,
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: networkKeys.deviceAuthorizations(household, binding),
    queryFn: ({ pageParam }) =>
      api.networkDeviceAuthorizations(household, binding, {
        limit: DEVICE_AUTHORIZATION_PAGE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) =>
      last.truncated ? last.offset + last.returned : undefined,
    enabled,
  });
}

export function useAuthorizeDevice(household: string, binding: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) =>
      api.networkDeviceAuthorize(household, binding, { device_id: deviceId }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: networkKeys.deviceAuthorizations(household, binding),
      }),
  });
}

export function useOwnEnrollDevices(household: string) {
  return useQuery(networkQueries.ownDevices(household));
}

export function useOwnGrants(household: string, enabled = true) {
  return useQuery({ ...networkQueries.ownGrants(household), enabled });
}

export function useOwnSessions(household: string, enabled = true) {
  return useQuery({ ...networkQueries.ownSessions(household), enabled });
}

export function useRegisterEnrollDevice(household: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.networkOwnDeviceRegister>[1]) =>
      api.networkOwnDeviceRegister(household, body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: networkKeys.ownDevices(household) }),
  });
}

/** Ending an enrollment also ends that device's grants and sessions on the server. */
export function useEndEnrolledDevice(household: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (device: string) => api.networkOwnDeviceEnd(household, device),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: networkKeys.enrollRoot(household) }),
  });
}

/** Resolves with the one-time `secret`. Keep it in component state only, never in the cache. */
export function useIssueSetupGrant(household: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.networkSetupGrantIssue>[1]) =>
      api.networkSetupGrantIssue(household, body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: networkKeys.ownGrants(household) }),
  });
}

export function useConsumeSetupGrant(household: string) {
  const queryClient = useQueryClient();
  return useMutation<NetworkVerifiedSession, Error, NetworkSetupGrantConsume>({
    mutationFn: (body) => api.networkSetupGrantConsume(household, body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: networkKeys.enrollRoot(household) }),
  });
}

export function useEndSession(household: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (session: string) => api.networkOwnSessionEnd(household, session),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: networkKeys.enrollRoot(household) }),
  });
}

/** Network sign-out for this binding. The dashboard session is untouched. */
export function useEndAllSessions(household: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.networkOwnSessionsEndAll(household),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: networkKeys.enrollRoot(household) }),
  });
}

/**
 * What a gateway last SAID about itself. Every field is an unverified observation from a worker
 * heartbeat; there is no accepted endpoint that verifies enforcement, so never present this as
 * "applied" without the word "reported".
 */
export interface GatewayObservation {
  reportedAt: string;
  observedAt: string;
  reportedCapabilities: string[];
  /** The revision the worker says it was told to run, as the raw string it sent (e.g. "r15"). */
  reportedDesiredRevision: string | null;
  /** The revision the worker claims it applied (e.g. "r14"). Unverified. */
  reportedAppliedRevision: string | null;
  reportedFailure: string | null;
}

export function toGatewayObservation(
  report: NetworkGatewayReport,
): GatewayObservation {
  return {
    reportedAt: report.reported_at,
    observedAt: report.observed_at,
    reportedCapabilities: report.capabilities,
    reportedDesiredRevision: report.desired_revision,
    reportedAppliedRevision: report.applied_revision,
    reportedFailure: report.failure,
  };
}

/** Policy revisions are numbers; workers report free text such as "r14" or "14". */
export function parseReportedRevision(raw: string | null): number | null {
  if (!raw) return null;
  const match = /^r?(\d+)$/i.exec(raw.trim());
  return match ? Number(match[1]) : null;
}

export interface GatewayStatus {
  gateway: NetworkGateway;
  /** Newest heartbeat report, or null when the worker has not reported. */
  observation: GatewayObservation | null;
  /** Revision an admin assigned as desired (a saved proposal), or null. */
  desired: NetworkDesiredPolicy | null;
}

/**
 * Gateways joined with each one's newest report and desired assignment.
 * `isPending` is true until the gateway list loaded; per-gateway detail fills in as it arrives.
 */
export function useGatewayStatuses(household: string, enabled = true) {
  const gateways = useQuery({ ...networkQueries.gateways(household), enabled });
  const list = gateways.data?.gateways ?? [];
  const reports = useQueries({
    queries: list.map((g) => ({
      ...networkQueries.gatewayReports(household, g.id, { limit: 1 }),
      enabled,
    })),
  });
  const desired = useQueries({
    queries: list.map((g) => ({
      ...networkQueries.gatewayDesired(household, g.id),
      enabled,
    })),
  });
  const statuses: GatewayStatus[] = list.map((gateway, i) => {
    const report = reports[i]?.data?.reports[0];
    return {
      gateway,
      observation: report ? toGatewayObservation(report) : null,
      desired: desired[i]?.data?.desired ?? null,
    };
  });
  return {
    statuses,
    isPending: enabled && gateways.isPending,
    isError: gateways.isError,
    error: gateways.error,
  };
}

/** After any inventory write, reload the household's inventory in one go. */
function useInvalidateInventory(household: string) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      queryKey: networkKeys.inventory(household),
    });
}

export function useBootstrapNetworkMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.networkBootstrap({ name }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: networkKeys.all }),
  });
}

export function useCreatePersonMutation(household: string) {
  const invalidate = useInvalidateInventory(household);
  return useMutation({
    mutationFn: (body: { display_name: string; note?: string }) =>
      api.networkPersonCreate(household, body),
    onSuccess: invalidate,
  });
}

export function useUpdatePersonMutation(household: string) {
  const invalidate = useInvalidateInventory(household);
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: { id: string } & Parameters<typeof api.networkPersonUpdate>[2]) =>
      api.networkPersonUpdate(household, id, body),
    onSuccess: invalidate,
  });
}

export function useCreateDeviceMutation(household: string) {
  const invalidate = useInvalidateInventory(household);
  return useMutation({
    mutationFn: (body: Parameters<typeof api.networkDeviceCreate>[1]) =>
      api.networkDeviceCreate(household, body),
    onSuccess: invalidate,
  });
}

export function useUpdateDeviceMutation(household: string) {
  const invalidate = useInvalidateInventory(household);
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: { id: string } & Parameters<typeof api.networkDeviceUpdate>[2]) =>
      api.networkDeviceUpdate(household, id, body),
    onSuccess: invalidate,
  });
}

export function useCreateAssignmentMutation(household: string) {
  const invalidate = useInvalidateInventory(household);
  return useMutation({
    mutationFn: (body: Parameters<typeof api.networkAssignmentCreate>[1]) =>
      api.networkAssignmentCreate(household, body),
    onSuccess: invalidate,
  });
}

export function useUpdateAssignmentMutation(household: string) {
  const invalidate = useInvalidateInventory(household);
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: { id: string } & Parameters<typeof api.networkAssignmentUpdate>[2]) =>
      api.networkAssignmentUpdate(household, id, body),
    onSuccess: invalidate,
  });
}

export function useGrantMutations(household: string) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: networkKeys.grants(household) });
  return {
    grant: useMutation({
      mutationFn: (body: Parameters<typeof api.networkGrantCreate>[1]) =>
        api.networkGrantCreate(household, body),
      onSuccess: invalidate,
    }),
    revoke: useMutation({
      mutationFn: ({
        userId,
        grant,
      }: {
        userId: string;
        grant: Parameters<typeof api.networkGrantDelete>[2];
      }) => api.networkGrantDelete(household, userId, grant),
      onSuccess: invalidate,
    }),
  };
}

export function useGatewayMutations(household: string) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: networkKeys.gatewaysRoot(household),
    });
  return {
    create: useMutation({
      mutationFn: (body: Parameters<typeof api.networkGatewayCreate>[1]) =>
        api.networkGatewayCreate(household, body),
      onSuccess: invalidate,
    }),
    revoke: useMutation({
      mutationFn: (gateway: string) =>
        api.networkGatewayRevoke(household, gateway),
      onSuccess: invalidate,
    }),
  };
}

/** Issue / rotate resolve with the one-time `token`; show it immediately, it is never served again. */
export function useGatewayCredentialMutations(
  household: string,
  gateway: string,
) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: networkKeys.gatewayCredentials(household, gateway),
    });
  return {
    issue: useMutation({
      mutationFn: (
        body: Parameters<typeof api.networkGatewayCredentialIssue>[2],
      ) => api.networkGatewayCredentialIssue(household, gateway, body),
      onSuccess: invalidate,
    }),
    rotate: useMutation({
      mutationFn: ({
        credential,
        ...body
      }: { credential: string } & Parameters<
        typeof api.networkGatewayCredentialRotate
      >[3]) =>
        api.networkGatewayCredentialRotate(
          household,
          gateway,
          credential,
          body,
        ),
      onSuccess: invalidate,
    }),
    revoke: useMutation({
      mutationFn: (credential: string) =>
        api.networkGatewayCredentialRevoke(household, gateway, credential),
      onSuccess: invalidate,
    }),
  };
}

/** Saving or rolling back creates a new saved revision; it is never applied by this call. */
export function usePolicyMutations(household: string) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: networkKeys.policiesRoot(household),
    });
  return {
    publish: useMutation({
      mutationFn: (body: Parameters<typeof api.networkPolicyPublish>[1]) =>
        api.networkPolicyPublish(household, body),
      onSuccess: invalidate,
    }),
    rollback: useMutation({
      mutationFn: (body: Parameters<typeof api.networkPolicyRollback>[1]) =>
        api.networkPolicyRollback(household, body),
      onSuccess: invalidate,
    }),
  };
}

export function useSetDesiredPolicyMutation(household: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      gateway,
      revision,
    }: {
      gateway: string;
      revision: number;
    }) => api.networkGatewayDesiredPolicySet(household, gateway, { revision }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: networkKeys.gatewaysRoot(household),
      }),
  });
}

export function useCreateConnectionMutation(household: string) {
  const invalidate = useInvalidateInventory(household);
  return useMutation({
    mutationFn: (body: Parameters<typeof api.networkConnectionCreate>[1]) =>
      api.networkConnectionCreate(household, body),
    onSuccess: invalidate,
  });
}

export function useUpdateConnectionMutation(household: string) {
  const invalidate = useInvalidateInventory(household);
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: { id: string } & Parameters<typeof api.networkConnectionUpdate>[2]) =>
      api.networkConnectionUpdate(household, id, body),
    onSuccess: invalidate,
  });
}
