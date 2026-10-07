import { get, postEmpty, postJsonRes, delJson } from "@/api/client";

export const enrollmentEndpoints = {
  /** Admin: LAN mDNS mode and agent WSS URL for onboarding (mirrors server `mdns_broadcast` rules). */
  getAgentSetupHints: (): Promise<{
    mdns: "advertising" | "disabled_by_env" | "unavailable_no_wss_url";
    agent_wss_url: string | null;
    mdns_port: number;
  }> => get("/settings/agent-setup-hints"),

  /** Admin: create a 6-digit pairing code for Windows agent claims. */
  createAgentEnrollmentToken: (body: {
    uses?: number;
    expires_in_hours?: number | null;
    note?: string | null;
    bound_agent_id?: string;
  }): Promise<{
    id: string;
    enrollment_token: string;
    uses: number;
    expires_at: string | null;
    note?: string | null;
    bound_agent_id?: string;
  }> => postJsonRes("/settings/agent-enrollment-tokens", body),

  /** Admin: list enrollment tokens (metadata only; plaintext code is shown once at creation). */
  listAgentEnrollmentTokens: (): Promise<{
    tokens: {
      id: string;
      uses_remaining: number;
      created_at: string;
      expires_at: string | null;
      note: string | null;
      used_count: number;
      last_used_at: string | null;
    }[];
  }> => get("/settings/agent-enrollment-tokens"),

  /** Admin: revoke an enrollment token (sets uses_remaining = 0). */
  revokeAgentEnrollmentToken: (id: string): Promise<{ ok: boolean }> =>
    delJson(`/settings/agent-enrollment-tokens/${encodeURIComponent(id)}`),

  /** Admin: revoke all enrollment tokens. */
  revokeAllAgentEnrollmentTokens: (): Promise<{ ok: boolean; revoked: number }> =>
    postEmpty("/settings/agent-enrollment-tokens/revoke-all"),

  /** Admin: list recent uses of an enrollment token. */
  listAgentEnrollmentTokenUses: (id: string): Promise<{
    uses: { used_at: string; agent_name: string; agent_id: string | null }[];
  }> => get(`/settings/agent-enrollment-tokens/${encodeURIComponent(id)}/uses`),

  listAgentEnrollmentClaims: (): Promise<{
    claims: {
      id: string;
      invite_id: string | null;
      status: "pending" | "approved" | "rejected" | "expired";
      requested_name: string;
      hostname: string | null;
      os: string | null;
      agent_version: string | null;
      client_ip: string | null;
      discovered_server: string | null;
      created_at: string;
      approved_by: string | null;
      approved_at: string | null;
      rejected_by: string | null;
      rejected_at: string | null;
      agent_id: string | null;
      error: string | null;
    }[];
  }> => get("/settings/agent-enrollment-claims"),

  approveAgentEnrollmentClaim: (
    id: string,
    body: { agent_name?: string | null; group_id?: string | null },
  ): Promise<{ ok: boolean; agent_id: string }> =>
    postJsonRes(`/settings/agent-enrollment-claims/${encodeURIComponent(id)}/approve`, body),

  rejectAgentEnrollmentClaim: (
    id: string,
    body: { error?: string | null } = {},
  ): Promise<{ ok: boolean }> =>
    postJsonRes(`/settings/agent-enrollment-claims/${encodeURIComponent(id)}/reject`, body),

  /** Admin: reset an agent’s saved token so it can enroll again. */
  revokeAgentCredentials: (agentId: string): Promise<{ ok: boolean }> =>
    postEmpty(`/agents/${encodeURIComponent(agentId)}/revoke-credentials`),
};
