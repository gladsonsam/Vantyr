import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, Eye, RefreshCw, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

const PAGE_SIZE = 50;

const FILTER_TABS: { value: EventFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "alerts", label: "Alerts" },
  { value: "appblock", label: "App Block" },
  { value: "scripts", label: "Scripts" },
  { value: "connections", label: "Connections" },
];

function typeClass(type: UnifiedEvent["type"]): string {
  if (type === "alert") return "text-info";
  if (type === "appblock") return "text-destructive";
  if (type === "script") return "text-success";
  return "text-muted-foreground";
}

function typeLabel(type: UnifiedEvent["type"]): string {
  if (type === "alert") return "Alert";
  if (type === "appblock") return "App Block";
  if (type === "script") return "Script";
  return "Connection";
}

function statusClass(status: string): string {
  if (status.includes("error") || status.includes("failed")) return "text-destructive";
  if (status.includes("skipped")) return "text-muted-foreground";
  return "text-success";
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
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [alertData, blockData, scriptData, sessionData] = await Promise.all([
        api.alertRuleEventsAll({ limit: 500 }).catch(() => ({ rows: [] as Record<string, unknown>[] })),
        api.appBlockEventsAll({ limit: 500 }).catch(() => ({ rows: [] as { id: number; agent_id: string; agent_name: string; rule_name?: string; exe_name: string; killed_at: string }[] })),
        api.scheduledScriptEventsAll({ limit: 500 }).catch(() => ({ rows: [] as { script_id: number; agent_id: string; agent_name: string; rule_name?: string; is_manual?: boolean; output?: string; status: string; expected_fire_time: string }[] })),
        api.agentSessionsAll({ limit: 500 }).catch(() => ({ rows: [] as { id: number; agent_id: string; agent_name: string; connected_at: string; disconnected_at?: string }[] })),
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

      const sess: UnifiedEvent[] = [];
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

  const pagesCount = Math.max(1, Math.ceil(allEvents.length / PAGE_SIZE));
  const activePage = Math.min(page, pagesCount);
  const displayed = useMemo(
    () => allEvents.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE),
    [allEvents, activePage],
  );

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (!autoRefreshEnabled) return;
    const id = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(id);
  }, [load, autoRefreshEnabled]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="font-heading text-xl font-semibold tracking-tight">
          Global Events{" "}
          <span className="font-mono text-sm font-normal text-muted-foreground tabular-nums">({allEvents.length})</span>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <Checkbox checked={autoRefreshEnabled} onCheckedChange={(checked) => setAutoRefreshEnabled(checked === true)} aria-label="Auto-refresh every 30 seconds" />
            Auto-refresh (30s)
          </label>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Spinner /> : <RefreshCw />} Refresh
          </Button>
        </div>
      </div>

      <Tabs value={filter} onValueChange={(value) => { setFilter(value as EventFilter); setPage(1); }} className="min-w-0">
        <TabsList aria-label="Event type" className="w-full justify-start overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {FILTER_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className="flex-none">
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {loading && allEvents.length === 0 ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : displayed.length === 0 ? (
        <Empty className="bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchX />
            </EmptyMedia>
            <EmptyTitle>No events yet</EmptyTitle>
            <EmptyDescription>Events from alerts, app blocks, scripts and connections will appear here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl bg-card">
          <Table>
            <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-44 pl-5!">Time</TableHead>
                <TableHead className="w-28">Type</TableHead>
                <TableHead className="w-44">Agent</TableHead>
                <TableHead className="w-52">Rule/Event</TableHead>
                <TableHead className="w-28">Status</TableHead>
                <TableHead>Detail</TableHead>
                <TableHead className="w-24">Screenshot</TableHead>
                <TableHead className="w-24 pr-5! text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_td]:px-3 [&_td]:py-3.5">
              {displayed.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="pl-5! font-mono text-xs tabular-nums">{fmtDateTime(r.time)}</TableCell>
                  <TableCell>
                    <span className={`text-xs font-medium ${typeClass(r.type)}`}>{typeLabel(r.type)}</span>
                  </TableCell>
                  <TableCell>{r.agent_name}</TableCell>
                  <TableCell>{r.rule_name || "—"}</TableCell>
                  <TableCell>
                    {r.status
                      ? <span className={`text-xs font-medium ${statusClass(r.status)}`}>{r.status}</span>
                      : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="max-w-72">
                    <span className="block max-h-24 truncate font-mono text-xs">{r.detail || "—"}</span>
                  </TableCell>
                  <TableCell>
                    {r.has_screenshot && r.screenshot_id
                      ? <Button variant="ghost" size="sm" onClick={() => setPreviewEventId(r.screenshot_id!)} aria-label={`View screenshot for event at ${r.time}`}><Eye /> View</Button>
                      : <span className="text-xs text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="pr-5! text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      render={<a href={`/agents/${r.agent_id}?tab=activity&at=${encodeURIComponent(r.time)}`} />}
                    >
                      View <ArrowRight />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <p className="font-mono text-xs text-muted-foreground tabular-nums">
              Page {activePage} of {pagesCount} · {allEvents.length} event{allEvents.length === 1 ? "" : "s"}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={activePage <= 1} onClick={() => setPage(activePage - 1)} aria-label="Previous page">
                <ChevronLeft /> Previous
              </Button>
              <Button variant="outline" size="sm" disabled={activePage >= pagesCount} onClick={() => setPage(activePage + 1)} aria-label="Next page">
                Next <ChevronRight />
              </Button>
            </div>
          </div>
        </div>
      )}
      <ScreenshotModal eventId={previewEventId} onClose={() => setPreviewEventId(null)} />
    </div>
  );
}
