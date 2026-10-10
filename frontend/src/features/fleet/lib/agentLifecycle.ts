import type { Agent } from "@/api/types";

export function withoutAgent<T>(items: Record<string, T>, id: string): Record<string, T> {
  if (!(id in items)) return items;
  const next = { ...items };
  delete next[id];
  return next;
}

export function retainAgents<T>(items: Record<string, T>, ids: Set<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(items).filter(([id]) => ids.has(id)));
}

export function disconnectedAgent(agent: Agent | undefined, timestamp?: string): Agent | undefined {
  if (!agent) return undefined;
  const disconnectedAt = timestamp || new Date().toISOString();
  return { ...agent, online: false, connected_at: null, last_seen: disconnectedAt, last_disconnected_at: disconnectedAt };
}
