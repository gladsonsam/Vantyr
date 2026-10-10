import type { ApiClient } from "@/api";
import { isoHoursAgo, isoMinutesAgo } from "@/demo/data";

/** Fake agent enrollment endpoints. */
export function demoEnrollmentApi(): Partial<ApiClient> {
  return {
    getAgentSetupHints: async () => ({ mdns: "advertising", agent_wss_url: "wss://demo.vantyr.local/ws/agent", mdns_port: 5353 }),
    createAgentEnrollmentToken: async (body) => ({
      id: "demo-token",
      enrollment_token: "123456",
      uses: body.uses ?? 1,
      expires_at: isoHoursAgo(-24),
      note: body.note ?? null,
      bound_agent_id: body.bound_agent_id,
    }),
    listAgentEnrollmentTokens: async () => ({
      tokens: [{ id: "demo-token", uses_remaining: 1, created_at: isoHoursAgo(1), expires_at: isoHoursAgo(-24), note: "Demo enrollment", used_count: 0, last_used_at: null }],
    }),
    revokeAgentEnrollmentToken: async () => ({ ok: true }),
    revokeAllAgentEnrollmentTokens: async () => ({ ok: true, revoked: 1 }),
    listAgentEnrollmentTokenUses: async () => ({ uses: [] }),
    listAgentEnrollmentClaims: async () => ({
      claims: [
        {
          id: "demo-claim",
          invite_id: "demo-token",
          status: "pending",
          requested_name: "NEW-LAPTOP",
          hostname: "NEW-LAPTOP",
          os: "Windows 11",
          agent_version: "0.2.9",
          client_ip: "10.0.8.44",
          discovered_server: "demo.vantyr.local",
          created_at: isoMinutesAgo(12),
          approved_by: null,
          approved_at: null,
          rejected_by: null,
          rejected_at: null,
          agent_id: null,
          error: null,
        },
      ],
    }),
    approveAgentEnrollmentClaim: async () => ({ ok: true, agent_id: "new-laptop" }),
    rejectAgentEnrollmentClaim: async () => ({ ok: true }),
    revokeAgentCredentials: async () => ({ ok: true }),
  };
}
