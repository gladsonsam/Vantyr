import type { AgentLiveStatus } from "./types";

/**
 * Merge a partial live-status patch onto the previous snapshot. Pure helper so the merge can be
 * applied inside a functional `setState` updater — this avoids dropping bursty WebSocket events
 * that would otherwise read a stale render snapshot of `liveStatus[id]`.
 */
export function mergeLiveStatus(
  prev: AgentLiveStatus | undefined,
  patch: Partial<AgentLiveStatus>,
): AgentLiveStatus {
  return { ...(prev ?? {}), ...patch };
}
