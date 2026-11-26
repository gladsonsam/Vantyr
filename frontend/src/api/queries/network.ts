import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";

/** Everything Vantyr Network sits under `networkKeys.all`; every key below it is household-scoped. */
export const networkKeys = {
  all: ["network"] as const,
  households: () => [...networkKeys.all, "households"] as const,
  inventory: (household: string) => [...networkKeys.all, household, "inventory"] as const,
  persons: (household: string) => [...networkKeys.inventory(household), "persons"] as const,
  devices: (household: string) => [...networkKeys.inventory(household), "devices"] as const,
  assignments: (household: string) => [...networkKeys.inventory(household), "assignments"] as const,
  connections: (household: string) => [...networkKeys.inventory(household), "connections"] as const,
  enrollments: (household: string) => [...networkKeys.inventory(household), "enrollments"] as const,
  grants: (household: string) => [...networkKeys.all, household, "grants"] as const,
};

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
};

/** After any inventory write, reload the household's inventory in one go. */
function useInvalidateInventory(household: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: networkKeys.inventory(household) });
}

export function useBootstrapNetworkMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.networkBootstrap({ name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: networkKeys.all }),
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
    mutationFn: ({ id, ...body }: { id: string } & Parameters<typeof api.networkPersonUpdate>[2]) =>
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
    mutationFn: ({ id, ...body }: { id: string } & Parameters<typeof api.networkDeviceUpdate>[2]) =>
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
