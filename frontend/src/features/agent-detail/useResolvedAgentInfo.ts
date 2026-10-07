import { useQuery } from "@tanstack/react-query";
import type { AgentInfo } from "@/api/types";
import { agentQueries } from "@/api/queries/agents";

/** The live `agentInfo` from props, or the stored `/info` snapshot when props omit it. */
export function useResolvedAgentInfo(agentId: string, agentInfo: AgentInfo | null) {
  const infoQuery = useQuery({ ...agentQueries.info(agentId), enabled: !agentInfo });
  return { resolvedInfo: agentInfo ?? infoQuery.data?.info ?? null };
}
