import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { auditQueries } from "@/api/queries/audit";
import { ruleQueries } from "@/api/queries/rules";
import {
  FEED_LIMIT,
  FEED_PAGE,
  feedRows,
  toAlertEvents,
  toBlockEvents,
  toScriptEvents,
  toSessionEvents,
  type EventFilter,
} from "../lib/globalEvents";

const AUTO_REFRESH_MS = 30_000;

/** The four event feeds, merged newest first and filtered to one kind; a feed that failed is named, not silently left out. */
export function useGlobalEvents(filter: EventFilter, autoRefresh: boolean) {
  const refetchInterval = autoRefresh ? AUTO_REFRESH_MS : false;
  const alertQuery = useQuery({ ...ruleQueries.alertEventsAll(FEED_PAGE), select: toAlertEvents, refetchInterval });
  const blockQuery = useQuery({ ...ruleQueries.appBlockEventsAll(FEED_PAGE), select: toBlockEvents, refetchInterval });
  const scriptQuery = useQuery({ ...ruleQueries.scheduledScriptEventsAll(FEED_PAGE), select: toScriptEvents, refetchInterval });
  const sessionQuery = useQuery({ ...auditQueries.agentSessions(FEED_PAGE), select: toSessionEvents, refetchInterval });
  const alertEvents = feedRows(alertQuery);
  const blockEvents = feedRows(blockQuery);
  const scriptEvents = feedRows(scriptQuery);
  const sessionEvents = feedRows(sessionQuery);

  const failed = [
    { filter: "alerts" as const, name: "alerts", failed: alertQuery.isError },
    { filter: "appblock" as const, name: "app blocks", failed: blockQuery.isError },
    { filter: "scripts" as const, name: "scripts", failed: scriptQuery.isError },
    { filter: "connections" as const, name: "connections", failed: sessionQuery.isError },
  ].filter((f) => f.failed);

  // The events to list, newest first, with how many each kind holds (for the tab counts).
  const { events, counts, capped } = useMemo(() => {
    let src = [...alertEvents, ...blockEvents, ...scriptEvents, ...sessionEvents];
    const kinds: Record<EventFilter, number> = {
      all: src.length,
      alerts: alertEvents.length,
      appblock: blockEvents.length,
      scripts: scriptEvents.length,
      connections: sessionEvents.length,
    };
    if (filter === "alerts") src = alertEvents;
    if (filter === "appblock") src = blockEvents;
    if (filter === "scripts") src = scriptEvents;
    if (filter === "connections") src = sessionEvents;
    return {
      events: [...src].sort((a, b) => b.time.localeCompare(a.time)),
      counts: kinds,
      // Each feed returns only its newest rows; say so when one is full.
      capped: Math.max(kinds.alerts, kinds.appblock, kinds.scripts, kinds.connections) >= FEED_LIMIT,
    };
  }, [filter, alertEvents, blockEvents, scriptEvents, sessionEvents]);

  const refresh = () => {
    void alertQuery.refetch();
    void blockQuery.refetch();
    void scriptQuery.refetch();
    void sessionQuery.refetch();
  };

  return {
    events,
    counts,
    capped,
    failedFeeds: failed.map((f) => f.name),
    failedFilters: new Set<EventFilter>(failed.map((f) => f.filter)),
    allFailed: failed.length === 4,
    loading: alertQuery.isFetching || blockQuery.isFetching || scriptQuery.isFetching || sessionQuery.isFetching,
    firstLoad: alertQuery.isPending || blockQuery.isPending || scriptQuery.isPending || sessionQuery.isPending,
    refresh,
  };
}
