import { useMemo, useState } from "react";
import type { Agent, AgentGroup, AlertRule } from "@/api/types";
import { channelLabel, ruleMatchSummary, scopeLabels } from "../lib/alertRuleSummary";

const PAGE_SIZE = 50;
/** The search box appears once there are enough rules for it to help. */
const SEARCH_FROM = 6;

/** Search (name, match, channel, scope) and paging over the rule list. */
export function useAlertRuleSearch(
  rules: AlertRule[],
  groups: AgentGroup[],
  agentsById: Record<string, Agent>,
) {
  const [query, setQueryState] = useState("");
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rules;
    return rules.filter((r) =>
      [
        r.name,
        r.pattern,
        channelLabel(r.channel),
        ruleMatchSummary(r),
        ...scopeLabels(r.scopes, groups, agentsById),
      ].some((text) => text.toLowerCase().includes(q)),
    );
  }, [rules, query, groups, agentsById]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const activePage = Math.min(page, pages);
  const displayed = useMemo(
    () => filtered.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE),
    [filtered, activePage],
  );

  return {
    query,
    setQuery: (value: string) => {
      setQueryState(value);
      setPage(1);
    },
    showSearch: rules.length >= SEARCH_FROM || query !== "",
    filteredCount: filtered.length,
    displayed,
    page: activePage,
    pages,
    setPage,
  };
}
