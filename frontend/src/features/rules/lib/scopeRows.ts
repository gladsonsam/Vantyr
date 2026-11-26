import type { ScopeFormRow } from "../rulesUtils";

/** Apply a change to one scope row, clearing the id that no longer matches the row's kind. */
export function updateScopeRow(
  rows: ScopeFormRow[],
  index: number,
  patch: Partial<ScopeFormRow>,
): ScopeFormRow[] {
  const next = [...rows];
  const cur = { ...next[index], ...patch };
  if (patch.kind === "all") {
    cur.group_id = "";
    cur.agent_id = "";
  }
  if (patch.kind === "group") cur.agent_id = "";
  if (patch.kind === "agent") cur.group_id = "";
  next[index] = cur;
  return next;
}

/**
 * Why these scope rows can't be saved, or null when they can. The server rejects a group or agent row that
 * names nothing, so say which kind of row is missing its choice before sending.
 */
export function scopesProblem(rows: ScopeFormRow[]): string | null {
  for (const row of rows) {
    if (row.kind === "group" && !row.group_id.trim()) return "Each group scope must select a group";
    if (row.kind === "agent" && !row.agent_id.trim())
      return "Each agent scope must select an agent";
  }
  return null;
}
