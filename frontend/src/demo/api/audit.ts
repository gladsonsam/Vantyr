import type { ApiClient } from "@/api";
import { demoAgents, isoHoursAgo, isoMinutesAgo } from "@/demo/data";

/** Fake audit trail and sessions endpoints. */
export function demoAuditApi(): Partial<ApiClient> {
  return {
    audit: async () => ({
      rows: [
        { id: 1, ts: isoMinutesAgo(5), actor: "admin", client_ip: null, agent_id: null, action: "demo.refresh", status: "ok", detail: { target: "dashboard" } },
        { id: 2, ts: isoMinutesAgo(22), actor: "operator", client_ip: null, agent_id: null, action: "agent.wake", status: "ok", detail: { target: "KIOSK-LOBBY" } },
      ],
    }),
    agentSessionsAll: async () => ({
      rows: demoAgents.map((a, i) => ({
        id: i + 1,
        agent_id: a.id,
        agent_name: a.name,
        connected_at: a.last_connected_at ?? isoHoursAgo(i + 1),
        disconnected_at: a.online ? null : a.last_disconnected_at,
      })),
    }),
  };
}
