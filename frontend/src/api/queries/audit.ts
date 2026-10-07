import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api";

export const auditKeys = {
  all: ["audit"] as const,
  /** Agent connect/disconnect sessions across the fleet (`/agent-sessions`). */
  agentSessions: (params: { limit?: number }) => [...auditKeys.all, "agent-sessions", params] as const,
};

export const auditQueries = {
  agentSessions: (params: { limit?: number }) =>
    queryOptions({
      queryKey: auditKeys.agentSessions(params),
      queryFn: () => api.agentSessionsAll(params),
    }),
};
