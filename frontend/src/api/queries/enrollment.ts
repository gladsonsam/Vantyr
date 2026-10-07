import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api";

export const enrollmentKeys = {
  all: ["enrollment"] as const,
  tokens: () => [...enrollmentKeys.all, "tokens"] as const,
  tokenUses: (tokenId: string) => [...enrollmentKeys.all, "tokens", tokenId, "uses"] as const,
  /** Devices waiting for an admin to approve their enrollment. */
  claims: () => [...enrollmentKeys.all, "claims"] as const,
  setupHints: () => [...enrollmentKeys.all, "setup-hints"] as const,
};

export const enrollmentQueries = {
  tokens: () =>
    queryOptions({
      queryKey: enrollmentKeys.tokens(),
      queryFn: () => api.listAgentEnrollmentTokens(),
    }),
  claims: () =>
    queryOptions({
      queryKey: enrollmentKeys.claims(),
      queryFn: () => api.listAgentEnrollmentClaims(),
    }),
  setupHints: () =>
    queryOptions({
      queryKey: enrollmentKeys.setupHints(),
      queryFn: () => api.getAgentSetupHints(),
    }),
};
