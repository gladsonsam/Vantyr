import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Box, Button, Pagination, SegmentedControl, Table, Toggle } from "../ui/console";
import { useCollection } from "../../hooks/useCollection";
import { api } from "../../lib/api";
import { fmtDateTime } from "../../lib/utils";
import { ScreenshotModal } from "./ScreenshotModal";

type EventFilter = "all" | "alerts" | "appblock" | "scripts" | "connections";

interface UnifiedEvent {
  id: string;
  type: "alert" | "appblock" | "script" | "connection";
  agent_id: string;
  agent_name: string;
  rule_name: string;
  detail: string;
  time: string;
  status?: string;
  screenshot_id?: number;
  has_screenshot?: boolean;
}

export function EventsGlobalTab() {
  const [filter, setFilter] = useState<EventFilter>("all");
  const [alertEvents, setAlertEvents] = useState<UnifiedEvent[]>([]);
  const [blockEvents, setBlockEvents] = useState<UnifiedEvent[]>([]);
  const [scriptEvents, setScriptEvents] = useState<UnifiedEvent[]>([]);
  const [sessionEvents, setSessionEvents] = useState<UnifiedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewEventId, setPreviewEventId] = useState<number | null>(null);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [alertData, blockData, scriptData, sessionData] = await Promise.all([
        api.alertRuleEventsAll({ limit: 500 }).catch(() => ({ rows: [] })),
        api.appBlockEventsAll({ limit: 500 }).catch(() => ({ rows: [] })),
        api.scheduledScriptEventsAll({ limit: 500 }).catch(() => ({ rows: [] })),
        api.agentSessionsAll({ limit: 500 }).catch(() => ({ rows: [] })),
      ]);

      setAlertEvents(
        (alertData.rows ?? []).map((r: Record<string, unknown>) => ({
          id: `a-${r.id}`,
          type: "alert" as const,
          agent_id: String(r.agent_id ?? ""),
          agent_name: String(r.agent_name ?? ""),
          rule_name: String(r.rule_name ?? ""),
          detail: String(r.snippet ?? ""),
          time: String(r.created_at ?? ""),
          screenshot_id: r.has_screenshot ? Number(r.id) : undefined,
          has_screenshot: Boolean(r.has_screenshot),
        })),
      );

      setBlockEvents(
        (blockData.rows).map((r) => ({
          id: `b-${r.id}`,
          type: "appblock" as const,
          agent_id: r.agent_id,
          agent_name: r.agent_name,
          rule_name: r.rule_name ?? r.exe_name,
          detail: r.exe_name,
          time: r.killed_at,
        })),
      );

      setScriptEvents(
        (scriptData.rows).map((r) => ({
          id: `s-${r.script_id}-${r.agent_id}-${r.expected_fire_time}`,
          type: "script" as const,
          agent_id: r.agent_id,
          agent_name: r.agent_name,
          rule_name: `${r.rule_name || "Unknown Script"}${r.is_manual ? " (manually triggered)" : ""}`,
          detail: r.output || "No output",
          status: r.status,
          time: r.expected_fire_time,
        })),
      );

      const sess = [];
      for (const r of sessionData.rows) {
        sess.push({
          id: `conn-${r.id}`,
          type: "connection" as const,
          agent_id: r.agent_id,
          agent_name: r.agent_name,
          rule_name: "Agent Connected",
          detail: "Agent came online",
          time: r.connected_at,
        });
        if (r.disconnected_at) {
          sess.push({
            id: `disconn-${r.id}`,
            type: "connection" as const,
            agent_id: r.agent_id,
            agent_name: r.agent_name,
            rule_name: "Agent Disconnected",
            detail: "Agent went offline",
            time: r.disconnected_at,
          });
        }
      }
      setSessionEvents(sess);

    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const allEvents = useMemo(() => {
    let src = [...alertEvents, ...blockEvents, ...scriptEvents, ...sessionEvents];
    if (filter === "alerts") src = alertEvents;
    if (filter === "appblock") src = blockEvents;
    if (filter === "scripts") src = scriptEvents;
    if (filter === "connections") src = sessionEvents;
    return src.sort((a, b) => b.time.localeCompare(a.time));
  }, [filter, alertEvents, blockEvents, scriptEvents, sessionEvents]);

  const { items: displayed, collectionProps, paginationProps } = useCollection(allEvents, {
    pagination: { pageSize: 50 },
    sorting: { defaultState: { sortingColumn: { sortingField: "time" }, isDescending: true } },
  });

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (!autoRefreshEnabled) return;
    const id = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(id);
  }, [load, autoRefreshEnabled]);

  return (
    <>
      <Table
        {...collectionProps}
        loading={loading}
        loadingText="Loading…"
        items={displayed}
        variant="container"
        stickyHeader
        header={
          <TablePropsHeader
            counter={allEvents.length}
            loading={loading}
            onRefresh={() => void load()}
            autoRefreshEnabled={autoRefreshEnabled}
            setAutoRefreshEnabled={setAutoRefreshEnabled}
            filter={filter}
            setFilter={setFilter}
          />
        }
        pagination={<Pagination {...paginationProps} />}
        empty={<Box textAlign="center" padding="l" color="text-body-secondary">No events yet.</Box>}
        columnDefinitions={[
          { id: "time", header: "Time", cell: (r) => fmtDateTime(r.time), sortingField: "time", width: 170 },
          { id: "type", header: "Type", cell: (r) => <Badge color={r.type === "alert" ? "blue" : r.type === "appblock" ? "red" : r.type === "script" ? "green" : "grey"}>{r.type === "alert" ? "Alert" : r.type === "appblock" ? "App Block" : r.type === "script" ? "Script" : "Connection"}</Badge>, width: 110 },
          { id: "agent", header: "Agent", cell: (r) => r.agent_name, width: 180 },
          { id: "rule", header: "Rule/Event", cell: (r) => r.rule_name || "—", width: 200 },
          { id: "status", header: "Status", cell: (r) => r.status ? <Badge color={r.status.includes("error") || r.status.includes("failed") ? "red" : r.status.includes("skipped") ? "grey" : "green"}>{r.status}</Badge> : <Box color="text-body-secondary">—</Box>, width: 110 },
          { id: "detail", header: "Detail", cell: (r) => <div style={{ fontSize: "14px", maxHeight: 100, overflow: "hidden", textOverflow: "ellipsis" }}><span style={{ fontFamily: "monospace", whiteSpace: "pre-wrap" }}>{r.detail || "—"}</span></div> },
          { id: "shot", header: "Screenshot", width: 110, cell: (r) => r.has_screenshot && r.screenshot_id ? <Button variant="inline-link" iconName="zoom-to-fit" onClick={() => setPreviewEventId(r.screenshot_id!)}>View</Button> : <Box color="text-body-secondary" fontSize="body-s">—</Box> },
          {
            id: "timeline",
            header: "Actions",
            width: 110,
            minWidth: 120,
            cell: (r) => (
              <Button
                variant="inline-link"
                iconName="angle-right"
                href={`/agents/${r.agent_id}?tab=activity&at=${encodeURIComponent(r.time)}`}
              >
                View
              </Button>
            ),
          },
        ]}
      />
      <ScreenshotModal eventId={previewEventId} onClose={() => setPreviewEventId(null)} />
    </>
  );
}

// Internal helper for Header component in Table to resolve circular type constraints cleanly
function TablePropsHeader({
  counter,
  loading,
  onRefresh,
  autoRefreshEnabled,
  setAutoRefreshEnabled,
  filter,
  setFilter,
}: {
  counter: number;
  loading: boolean;
  onRefresh: () => void;
  autoRefreshEnabled: boolean;
  setAutoRefreshEnabled: (v: boolean) => void;
  filter: EventFilter;
  setFilter: (f: EventFilter) => void;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", flexWrap: "wrap", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 800 }}>
          Global Events
          <span className="sx-mono" style={{ marginLeft: 8, fontSize: "14px", color: "var(--text-3)" }}>
            ({counter})
          </span>
        </h2>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Toggle
          checked={autoRefreshEnabled}
          onChange={({ detail }) => setAutoRefreshEnabled(detail.checked)}
        >
          Auto-refresh (30s)
        </Toggle>
        <Button iconName="refresh" variant="normal" onClick={onRefresh} loading={loading}>Refresh</Button>
        <SegmentedControl selectedId={filter} options={[
          { id: "all", text: "All" }, 
          { id: "alerts", text: "Alerts" }, 
          { id: "appblock", text: "App Block" },
          { id: "scripts", text: "Scripts" },
          { id: "connections", text: "Connections" }
        ]}
          onChange={({ detail }) => setFilter(detail.selectedId as EventFilter)} />
      </div>
    </div>
  );
}
