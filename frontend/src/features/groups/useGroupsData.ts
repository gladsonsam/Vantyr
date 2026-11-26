import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentQueries } from "@/api/queries/agents";
import { groupQueries } from "@/api/queries/groups";
import { ruleQueries } from "@/api/queries/rules";
import type { Agent, AgentGroup } from "@/api/types";
import { messageOf, ruleCountsByGroup } from "./groupSummary";

const NO_GROUPS: AgentGroup[] = [];
const NO_AGENTS: Agent[] = [];

/** What the Groups page lists: the groups, the devices they hold, and the alert rules that target them. */
export function useGroupsData() {
  const groupsQuery = useQuery(groupQueries.list());
  const agentsQuery = useQuery(agentQueries.overview());
  const rulesQuery = useQuery(ruleQueries.alertRules());

  const groups = groupsQuery.data?.groups ?? NO_GROUPS;
  const agents = agentsQuery.data?.agents ?? NO_AGENTS;
  // Unknown (still loading, or failed) stays null so the list says nothing instead of "no rules".
  const ruleCounts = useMemo(
    () =>
      rulesQuery.data && !rulesQuery.isError ? ruleCountsByGroup(rulesQuery.data.rules) : null,
    [rulesQuery.data, rulesQuery.isError],
  );
  const agentOptions = useMemo(
    () =>
      [...agents]
        .sort((x, y) => x.name.localeCompare(y.name))
        .map((a) => ({ label: `${a.name} (${a.id.slice(0, 8)}…)`, value: a.id })),
    [agents],
  );
  const groupOptions = useMemo(() => groups.map((g) => ({ label: g.name, value: g.id })), [groups]);

  const idle = (q: { isError: boolean; isFetching: boolean }) => q.isError && !q.isFetching;
  return {
    groups,
    agents,
    ruleCounts,
    agentOptions,
    groupOptions,
    loading: groupsQuery.isFetching || agentsQuery.isFetching || rulesQuery.isFetching,
    firstLoad: groupsQuery.isPending,
    /** The list failed and there is nothing older to show. */
    listError: groupsQuery.isError && groups.length === 0 ? messageOf(groupsQuery.error) : null,
    /** A refresh failed while an older list is still on screen. */
    staleError: idle(groupsQuery) && groups.length > 0 ? messageOf(groupsQuery.error) : null,
    agentsError: idle(agentsQuery) ? messageOf(agentsQuery.error) : null,
    retryGroups: () => void groupsQuery.refetch(),
    retryAgents: () => void agentsQuery.refetch(),
    refresh: () =>
      void Promise.all([groupsQuery.refetch(), agentsQuery.refetch(), rulesQuery.refetch()]),
  };
}
