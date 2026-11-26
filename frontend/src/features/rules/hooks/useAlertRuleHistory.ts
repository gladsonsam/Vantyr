import { useQuery } from "@tanstack/react-query";
import { ruleQueries } from "@/api/queries/rules";
import type { AlertRuleTriggeredEvent } from "@/api/types";

export interface AlertRuleHistoryRow {
  id: number;
  agent_id: string;
  agent_name: string;
  snippet: string;
  has_screenshot: boolean;
  /** The rule asks for a screenshot, so a missing one means the capture failed. */
  screenshot_requested: boolean;
  created_at: string;
}

const NO_HISTORY: AlertRuleHistoryRow[] = [];
const HISTORY_LIMIT = 200;
const HISTORY_PAGE = { limit: HISTORY_LIMIT };

export function toHistoryRows(data: { rows: AlertRuleTriggeredEvent[] }): AlertRuleHistoryRow[] {
  return (data.rows ?? []).map((row) => ({
    id: Number(row.id),
    agent_id: String(row.agent_id ?? ""),
    agent_name: String(row.agent_name ?? ""),
    snippet: String(row.snippet ?? ""),
    has_screenshot: Boolean(row.has_screenshot),
    screenshot_requested: Boolean(row.screenshot_requested),
    created_at: String(row.created_at ?? ""),
  }));
}

/** Recent trigger events for one alert rule; idle while `ruleId` is null. */
export function useAlertRuleHistory(ruleId: number | null) {
  const query = useQuery({
    ...ruleQueries.alertEventsForRule(ruleId ?? 0, HISTORY_PAGE),
    enabled: ruleId !== null,
    select: toHistoryRows,
  });
  const events = query.data ?? NO_HISTORY;
  return {
    events,
    // Only the first load: a refresh keeps the rows on screen.
    loading: query.isLoading,
    error: query.error,
    /** The newest events were returned; older ones exist when the page came back full. */
    truncated: events.length >= HISTORY_LIMIT,
    refetch: () => void query.refetch(),
  };
}
