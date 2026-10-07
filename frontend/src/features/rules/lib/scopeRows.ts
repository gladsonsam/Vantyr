import type { ScopeFormRow } from "../rulesUtils";

/** Apply a change to one scope row, clearing the id that no longer matches the row's kind. */
export function updateScopeRow(rows: ScopeFormRow[], index: number, patch: Partial<ScopeFormRow>): ScopeFormRow[] {
  const next = [...rows];
  const cur = { ...next[index], ...patch };
  if (patch.kind === "all") { cur.group_id = ""; cur.agent_id = ""; }
  if (patch.kind === "group") cur.agent_id = "";
  if (patch.kind === "agent") cur.group_id = "";
  next[index] = cur;
  return next;
}
