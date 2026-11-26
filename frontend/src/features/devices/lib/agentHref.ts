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
 * Link for an agent's device page. With `agentTools` it opens the Agent tab, carrying `?tab=` and
 * the other tool params in `search`. Without rows (or for an agent they do not know) it falls back
 * to the legacy `/agents/<id>` route, which redirects to the same place.
 */
export function deviceHrefForAgent(
  agentId: string,
  rows: readonly DeviceRow[] | null | undefined,
  agentTools?: { search?: string },
): string {
  const key = rows ? deviceKeyForAgent(agentId, rows) : null;
  if (key) return deviceHref(key, agentTools);
  const search = agentTools?.search ?? "";
  return `/agents/${encodeURIComponent(agentId)}${search && !search.startsWith("?") ? `?${search}` : search}`;
}
