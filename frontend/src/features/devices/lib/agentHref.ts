import type { DeviceRow } from "@/features/devices/lib/deviceModel";

/** The route key of the device an agent belongs to: its household device id, else `agent:<id>`. */
export function deviceKeyForAgent(agentId: string, rows: readonly DeviceRow[]): string | null {
  return rows.find((row) => row.agentId === agentId)?.key ?? null;
}

/** `/devices/<key>` for a row, or its Agent tab (the agent tools) with `agentTools`. */
export function deviceHref(key: string, agentTools?: { search?: string }): string {
  const base = `/devices/${key}`;
  if (!agentTools) return base;
  const search = agentTools.search ?? "";
  return `${base}/agent${search && !search.startsWith("?") ? `?${search}` : search}`;
}

/**
 * Link for an agent's device page, or null when no row belongs to that agent. With `agentTools` it
 * opens the Agent tab, carrying `?tab=` and the other tool params in `search`.
 */
export function deviceHrefForAgent(
  agentId: string,
  rows: readonly DeviceRow[],
  agentTools?: { search?: string },
): string | null {
  const key = deviceKeyForAgent(agentId, rows);
  return key ? deviceHref(key, agentTools) : null;
}
