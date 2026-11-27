import { useCallback } from "react";
import { useDeviceRows } from "@/features/devices/hooks/useDeviceRows";
import { deviceHrefForAgent } from "@/features/devices/lib/agentHref";

/** Resolves an agent to its device page (or its Agent tab); null while no device row belongs to it. */
export function useAgentHref(): (
  agentId: string,
  agentTools?: { search?: string },
) => string | null {
  const { rows } = useDeviceRows();
  return useCallback(
    (agentId: string, agentTools?: { search?: string }) =>
      deviceHrefForAgent(agentId, rows, agentTools),
    [rows],
  );
}
