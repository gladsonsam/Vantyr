import { useCallback, useEffect, useRef, useState } from "react";
import type { TabKey, WsEvent } from "../lib/types";
import { api } from "../lib/api";
import {
  aggregateSessions,
  attachAlertEventsToSessions,
  type Session,
  type SessionAlertEvent,
} from "../lib/session-aggregator";
import { parseTimestamp } from "../lib/utils";

const REFRESH_EVENTS = new Set([
  "window_focus",
  "url",
  "keys",
  "afk",
  "active",
  "alert_rule_match",
]);

/**
 * Loads merged timeline sessions when the Live / Activity tabs are active,
 * and debounces refreshes on relevant agent WebSocket events.
 */
export function useAgentActivitySessions(agentId: string, activeTab: TabKey) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTabRef = useRef(activeTab);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  // Keep raw pages in refs so we can recompute sessions on load-more without
  // triggering intermediate rerenders for each dataset.
interface RawWindowRow {
  hwnd: number;
  title: string;
  app: string;
  app_display?: string;
  ts?: string;
  created?: string;
  user?: string | null;
}

interface RawUrlRow {
  id?: number;
  url: string;
  browser: string;
  ts: string;
  user?: string | null;
}

interface RawKeyRow {
  window_title: string;
  app: string;
  app_display?: string;
  text: string;
  updated_at?: string;
  started_at?: string;
  user?: string | null;
}

interface RawAlertRow {
  id?: number | string;
  rule_name?: string;
  channel?: string;
  snippet?: string;
  created_at?: string;
  has_screenshot?: boolean;
  screenshot_requested?: boolean;
}

  const rawRef = useRef<{
    windows: RawWindowRow[];
    urls: RawUrlRow[];
    keys: RawKeyRow[];
    alerts: RawAlertRow[];
    pageSize: number;
    offsets: { windows: number; urls: number; keys: number; alerts: number };
    hasMore: { windows: boolean; urls: boolean; keys: boolean; alerts: boolean };
  }>({
    windows: [],
    urls: [],
    keys: [],
    alerts: [],
    pageSize: 750,
    offsets: { windows: 0, urls: 0, keys: 0, alerts: 0 },
    hasMore: { windows: true, urls: true, keys: true, alerts: true },
  });

  const recomputeSessions = useCallback(() => {
    const { windows, urls, keys, alerts } = rawRef.current;

    const windowRows = windows
      .map((row: RawWindowRow) => ({
        id: row.hwnd,
        window_title: row.title ?? "",
        exe_name: row.app ?? "",
        app_display: row.app_display ?? row.app ?? "",
        timestamp: row.ts || row.created || "",
        user: row.user ?? null,
      }))
      .filter((row) => parseTimestamp(row.timestamp));

    const urlRows = urls
      .map((row: RawUrlRow) => ({
        id: row.id ?? 0,
        url: row.url ?? "",
        browser: row.browser ?? "",
        timestamp: row.ts ?? "",
        user: row.user ?? null,
      }))
      .filter((row) => parseTimestamp(row.timestamp));

    const keyRows = keys
      .map((row: RawKeyRow) => ({
        id: 0,
        window_title: row.window_title ?? "",
        exe_name: row.app ?? "",
        app_display: row.app_display ?? row.app ?? "",
        keys: row.text ?? "",
        timestamp: row.updated_at || row.started_at || "",
        user: row.user ?? null,
      }))
      .filter((row) => parseTimestamp(row.timestamp));

    let alertEvents: SessionAlertEvent[] = [];
    try {
      alertEvents = (alerts ?? []).map((row: RawAlertRow) => ({
        id: Number(row.id ?? 0),
        rule_name: String(row.rule_name ?? ""),
        channel: String(row.channel ?? ""),
        snippet: String(row.snippet ?? ""),
        created_at: String(row.created_at ?? ""),
        has_screenshot: Boolean(row.has_screenshot),
        screenshot_requested: Boolean(row.screenshot_requested),
      }));
    } catch {
      alertEvents = [];
    }

    const aggregated = attachAlertEventsToSessions(
      aggregateSessions({
        windows: windowRows,
        urls: urlRows,
        keystrokes: keyRows,
      }),
      alertEvents,
    );
    setSessions(aggregated.map((s) => ({ ...s, agentId })));

    const h = rawRef.current.hasMore;
    setHasMoreOlder(Boolean(h.windows || h.urls || h.keys || h.alerts));
  }, [agentId]);

  const loadFirstPage = useCallback(async () => {
    const pageSize = rawRef.current.pageSize;
    rawRef.current.offsets = { windows: 0, urls: 0, keys: 0, alerts: 0 };
    rawRef.current.hasMore = { windows: true, urls: true, keys: true, alerts: true };

    const [windowsRes, urlsRes, keysRes, alertsRes] = await Promise.allSettled([
      api.windows(agentId, { limit: pageSize, offset: 0 }),
      api.urls(agentId, { limit: pageSize, offset: 0 }),
      api.keys(agentId, { limit: pageSize, offset: 0 }),
      api.agentAlertRuleEvents(agentId, { limit: pageSize, offset: 0 }),
    ]);

    const windows = windowsRes.status === "fulfilled" ? windowsRes.value.rows : [];
    const urls = urlsRes.status === "fulfilled" ? urlsRes.value.rows : [];
    const keys = keysRes.status === "fulfilled" ? keysRes.value.rows : [];
    const alerts = alertsRes.status === "fulfilled" ? alertsRes.value.rows : [];

    rawRef.current.windows = windows;
    rawRef.current.urls = urls;
    rawRef.current.keys = keys;
    rawRef.current.alerts = alerts;

    rawRef.current.hasMore.windows = windows.length >= pageSize;
    rawRef.current.hasMore.urls = urls.length >= pageSize;
    rawRef.current.hasMore.keys = keys.length >= pageSize;
    rawRef.current.hasMore.alerts = alerts.length >= pageSize;

    recomputeSessions();
  }, [agentId, recomputeSessions]);

  const loadMoreOlderActivity = useCallback(async () => {
    if (loadingMore) return;
    const pageSize = rawRef.current.pageSize;
    const h = rawRef.current.hasMore;
    if (!h.windows && !h.urls && !h.keys && !h.alerts) {
      setHasMoreOlder(false);
      return;
    }
    setLoadingMore(true);
    try {
      const nextOffsets = rawRef.current.offsets;
      const next = {
        windows: h.windows ? nextOffsets.windows + pageSize : nextOffsets.windows,
        urls: h.urls ? nextOffsets.urls + pageSize : nextOffsets.urls,
        keys: h.keys ? nextOffsets.keys + pageSize : nextOffsets.keys,
        alerts: h.alerts ? nextOffsets.alerts + pageSize : nextOffsets.alerts,
      };

      const [windowsRes, urlsRes, keysRes, alertsRes] = await Promise.allSettled([
        h.windows ? api.windows(agentId, { limit: pageSize, offset: next.windows }) : Promise.resolve({ rows: [] }),
        h.urls ? api.urls(agentId, { limit: pageSize, offset: next.urls }) : Promise.resolve({ rows: [] }),
        h.keys ? api.keys(agentId, { limit: pageSize, offset: next.keys }) : Promise.resolve({ rows: [] }),
        h.alerts
          ? api.agentAlertRuleEvents(agentId, { limit: pageSize, offset: next.alerts })
          : Promise.resolve({ rows: [] }),
      ]);

      const winRows = windowsRes.status === "fulfilled" ? windowsRes.value.rows : [];
      const urlRows = urlsRes.status === "fulfilled" ? urlsRes.value.rows : [];
      const keyRows = keysRes.status === "fulfilled" ? keysRes.value.rows : [];
      const alertRows = alertsRes.status === "fulfilled" ? alertsRes.value.rows : [];

      if (h.windows) {
        rawRef.current.windows = rawRef.current.windows.concat(winRows);
        rawRef.current.offsets.windows = next.windows;
        rawRef.current.hasMore.windows = winRows.length >= pageSize;
      }
      if (h.urls) {
        rawRef.current.urls = rawRef.current.urls.concat(urlRows);
        rawRef.current.offsets.urls = next.urls;
        rawRef.current.hasMore.urls = urlRows.length >= pageSize;
      }
      if (h.keys) {
        rawRef.current.keys = rawRef.current.keys.concat(keyRows);
        rawRef.current.offsets.keys = next.keys;
        rawRef.current.hasMore.keys = keyRows.length >= pageSize;
      }
      if (h.alerts) {
        rawRef.current.alerts = rawRef.current.alerts.concat(alertRows);
        rawRef.current.offsets.alerts = next.alerts;
        rawRef.current.hasMore.alerts = alertRows.length >= pageSize;
      }

      recomputeSessions();
    } finally {
      setLoadingMore(false);
    }
  }, [agentId, loadingMore, recomputeSessions]);

  const loadActivityData = useCallback(async () => {
    try {
      setLoading(true);
      await loadFirstPage();
    } catch (err) {
      console.error("Failed to load activity data:", err);
    } finally {
      setLoading(false);
    }
  }, [loadFirstPage]);

  useEffect(() => {
    if (activeTab === "activity" || activeTab === "live") {
      void loadActivityData();
    }
  }, [activeTab, agentId, loadActivityData]);

  useEffect(() => {
    if (activeTab !== "activity" && activeTab !== "live") return;
    const onWsEvent = (event: Event) => {
      const detail = (event as CustomEvent<WsEvent>).detail;
      if (!detail || !("agent_id" in detail) || detail.agent_id !== agentId) return;
      if (!("event" in detail)) return;
      const ev = detail.event;
      if (!REFRESH_EVENTS.has(ev)) return;
      if (activeTabRef.current !== "activity" && activeTabRef.current !== "live") return;

      if (refreshDebounceRef.current) {
        clearTimeout(refreshDebounceRef.current);
      }
      refreshDebounceRef.current = setTimeout(() => {
        void loadActivityData();
      }, 500);
    };

    window.addEventListener("vantyr-ws-event", onWsEvent as EventListener);
    return () => {
      window.removeEventListener("vantyr-ws-event", onWsEvent as EventListener);
      if (refreshDebounceRef.current) {
        clearTimeout(refreshDebounceRef.current);
        refreshDebounceRef.current = null;
      }
    };
  }, [activeTab, agentId, loadActivityData]);

  return { sessions, loading, loadingMore, hasMoreOlder, loadMoreOlderActivity, loadActivityData };
}
