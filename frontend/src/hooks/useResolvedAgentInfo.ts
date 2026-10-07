import { useEffect, useState } from "react";
import type { AgentInfo } from "@/api/types";
import { api } from "@/api";

/** Keeps `agentInfo` in sync with props; fetches `/info` when props omit it. */
export function useResolvedAgentInfo(agentId: string, agentInfo: AgentInfo | null) {
  const [resolvedInfo, setResolvedInfo] = useState<AgentInfo | null>(agentInfo ?? null);

  useEffect(() => {
    if (agentInfo) {
      setResolvedInfo(agentInfo);
      return;
    }
    let cancelled = false;
    void api
      .agentInfo(agentId)
      .then((d) => {
        if (!cancelled) setResolvedInfo(d.info ?? null);
      })
      .catch(() => {
        /* keep stale */
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, agentInfo]);

  return { resolvedInfo, setResolvedInfo };
}
