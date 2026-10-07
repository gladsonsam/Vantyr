import type { AgentSessionEvent, AuditRecord } from "@/api/types";
import { get, limitOffsetQuery } from "@/api/client";

export const auditEndpoints = {
  // ── Audit log ─────────────────────────────────────────────────────────────

  audit: (params?: { limit?: number; agent_id?: string; status?: string }): Promise<{ rows: AuditRecord[] }> => {
    const q = new URLSearchParams();
    q.set("limit", String(params?.limit ?? 500));
    if (params?.agent_id) q.set("agent_id", params.agent_id);
    if (params?.status) q.set("status", params.status);
    return get(`/audit?${q.toString()}`);
  },

  agentSessionsAll: (
    params?: { limit?: number },
  ): Promise<{ rows: AgentSessionEvent[] }> =>
    get(`/agent-sessions${limitOffsetQuery(params)}`),
};
