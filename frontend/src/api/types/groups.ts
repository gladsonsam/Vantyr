// ── Alert rules & agent groups (admin) ───────────────────────────────────────

export interface AgentGroup {
  id: string;
  name: string;
  description: string;
  created_at: string;
  member_count: number;
}

/** Subset returned for one agent’s group memberships (no counts or timestamps). */
export interface AgentGroupMembership {
  id: string;
  name: string;
  description: string;
}
