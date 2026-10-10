import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api";

export type AuditLogParams = { limit?: number; agent_id?: string; status?: string };

export const auditKeys = {
  all: ["audit"] as const,
  /** Dashboard audit log (`/audit`), optionally for one agent and/or one status. */
  log: (params: AuditLogParams) => [...auditKeys.all, "log", params] as const,
  /** Agent connect/disconnect sessions across the fleet (`/agent-sessions`). */
  agentSessions: (params: { limit?: number }) => [...auditKeys.all, "agent-sessions", params] as const,
};

export const auditQueries = {
  log: (params: AuditLogParams) =>
    queryOptions({
      queryKey: auditKeys.log(params),
      queryFn: () => api.audit(params),
    }),
  agentSessions: (params: { limit?: number }) =>
    queryOptions({
      queryKey: auditKeys.agentSessions(params),
      queryFn: () => api.agentSessionsAll(params),
    }),
};
