import { Activity, History } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { DataTable } from "@/components/common/data-table/DataTable";
import { DataTableColumnHeader } from "@/components/common/data-table/DataTableColumnHeader";
import { DataTablePagination } from "@/components/common/data-table/DataTablePagination";
import { createDataTableColumns } from "@/components/common/data-table/features";
import { useDataTable } from "@/components/common/data-table/useDataTable";
import { useCallback, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { agentQueries } from "@/api/queries/agents";
import { prettyAppLabel } from "@/lib/appNames";
import { AppIcon } from "@/components/common/AppIcon";
import { applyActivityStateToSearchParams } from "@/features/activity/activityUrl";
import { useAgentToolsPath } from "@/features/agent-detail/agentToolsPath";
import { agentRecallHref } from "@/features/recall/lib/recallUrl";
import type { AgentInfo, WindowEvent as WindowEventRow, WindowTopRow } from "@/api/types";
import { capabilityAvailable } from "@/features/agent-detail/lib/agentCapabilities";
import { CapabilityNotice } from "@/features/agent-detail/components/CapabilityNotice";
import {
  LoadFailed,
  MonitoringToolbar,
  ROW_ACTIONS_CLASS,
  ROW_ACTION_BUTTON_CLASS,
} from "@/features/agent-detail/components/MonitoringToolbar";
import { listCountLabel, titleRestatesApp } from "@/features/agent-detail/lib/monitoring";
import { DayTimeCell } from "@/components/common/data-table/DayTimeCell";

interface WindowEvent {
  id: number;
  window_title: string;
  exe_name: string;
  app_display?: string;
  timestamp: string;
  user?: string | null;
}

interface TopWindowRow {
  app: string;
  app_display?: string;
  title: string;
  focus_count: number;
  last_ts: string;
}

interface WindowsTabProps {
  agentId: string;
  agentInfo?: AgentInfo | null;
}

function matchesWindow(item: WindowEvent, filteringText: string): boolean {
  const searchText = filteringText.toLowerCase();
  return (
    (item.app_display || "").toLowerCase().includes(searchText) ||
    (item.exe_name || "").toLowerCase().includes(searchText) ||
    (item.window_title || "").toLowerCase().includes(searchText) ||
    (item.user || "").toLowerCase().includes(searchText)
  );
}

const columnHelper = createDataTableColumns<WindowEvent>();

function windowColumns(
  agentId: string,
  openInActivity: (q: string) => void,
  openInRecall: (iso: string) => void,
) {
  return columnHelper.columns([
    columnHelper.accessor((item) => item.user ?? undefined, {
      id: "user",
      header: ({ column }) => <DataTableColumnHeader column={column} title="User" />,
      cell: ({ row }) => row.original.user || "—",
      meta: { className: "whitespace-nowrap", hideWhenUniform: true },
    }),
    columnHelper.accessor("timestamp", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Time" />,
      cell: ({ row, table }) => (
        <DayTimeCell table={table} columnId="timestamp" ts={row.original.timestamp} />
      ),
      meta: { className: "whitespace-nowrap text-[13px] text-muted-foreground tabular-nums" },
    }),
    columnHelper.accessor("exe_name", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Application" />,
      cell: ({ row, table }) => {
        const item = row.original;
        return (
          <div className="flex items-center gap-2">
            <AppIcon agentId={agentId} exeName={item.exe_name} size={16} />
            <button
              type="button"
              onClick={() => table.setGlobalFilter(item.exe_name ?? "")}
              title={`Only show ${item.exe_name}`}
              className="inline-flex min-h-7 cursor-pointer items-center p-0 text-left hover:underline max-sm:min-h-7 pointer-coarse:min-h-9"
            >
              {prettyAppLabel({ exeName: item.exe_name, appDisplay: item.app_display })}
            </button>
          </div>
        );
      },
      meta: { className: "whitespace-nowrap" },
    }),
    columnHelper.accessor("window_title", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Window title" />,
      cell: ({ row }) => {
        const item = row.original;
        const title = titleRestatesApp(item.window_title, item.app_display, item.exe_name)
          ? ""
          : item.window_title;
        return (
          <div className="flex items-start justify-between gap-2.5">
            <span className="min-w-0 wrap-break-word">
              {title || <span className="text-muted-foreground">Untitled window</span>}
            </span>
            <span className={ROW_ACTIONS_CLASS}>
              {item.window_title?.trim() ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={ROW_ACTION_BUTTON_CLASS}
                  aria-label="Show in timeline"
                  title="Show in timeline"
                  onClick={() => openInActivity(item.window_title)}
                >
                  <Activity />
                </Button>
              ) : null}
              {item.timestamp ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={ROW_ACTION_BUTTON_CLASS}
                  aria-label="Open in Recall"
                  title="Open in Recall"
                  onClick={() => openInRecall(item.timestamp)}
                >
                  <History />
                </Button>
              ) : null}
            </span>
          </div>
        );
      },
      meta: { className: "w-full max-sm:order-first max-sm:basis-full" },
    }),
  ]);
}

const WINDOWS_LIMIT = 500;
const WINDOWS_PAGE = { limit: WINDOWS_LIMIT };
const FOCUS_EVENTS = { one: "focus change", many: "focus changes" };
const TOP_CHIPS = 3;
const TOP_WINDOWS_PAGE = { limit: 20 };
const NO_WINDOWS: WindowEvent[] = [];
const NO_TOP_WINDOWS: TopWindowRow[] = [];

function toWindowEvents({ rows }: { rows: WindowEventRow[] }): WindowEvent[] {
  return rows.map((row, i) => ({
    // `hwnd` is a window handle, not an event id: the same window focused
    // repeatedly yields the same hwnd, so using it as the row key collides
    // (React duplicate-key warning, and rows can be dropped on re-render).
    // The endpoint returns no per-row id, so key on position.
    id: i + 1,
    window_title: row.title ?? "—",
    exe_name: row.app ?? "—",
    app_display: row.app_display?.trim() ? row.app_display : (row.app ?? "—"),
    timestamp: row.ts,
    user: row.user ?? null,
  }));
}

function toTopWindows({ rows }: { rows: WindowTopRow[] }): TopWindowRow[] {
  return rows.map((row) => ({
    app: row.app ?? "",
    app_display: row.app_display ?? "",
    title: row.title ?? "",
    focus_count: row.focus_count ?? 0,
    last_ts: row.last_ts ?? "",
  }));
}

export function WindowsTab({ agentId, agentInfo }: WindowsTabProps) {
  const navigate = useNavigate();
  const activeWindowAvailable = capabilityAvailable(agentInfo, "active_window");
  const [windowsQuery, topWindowsQuery] = useQueries({
    queries: [
      {
        ...agentQueries.windows(agentId, WINDOWS_PAGE),
        enabled: activeWindowAvailable,
        select: toWindowEvents,
      },
      {
        ...agentQueries.topWindows(agentId, TOP_WINDOWS_PAGE),
        enabled: activeWindowAvailable,
        select: toTopWindows,
      },
    ],
  });
  const items = windowsQuery.data ?? NO_WINDOWS;
  const topItems = topWindowsQuery.data ?? NO_TOP_WINDOWS;
  const loading = windowsQuery.isFetching || topWindowsQuery.isFetching;
  const fetchWindows = () => {
    void windowsQuery.refetch();
    void topWindowsQuery.refetch();
  };

  const toolsPath = useAgentToolsPath();
  const openInActivity = useCallback(
    (q: string) => {
      const qs = applyActivityStateToSearchParams(new URLSearchParams(), { q });
      navigate(`${toolsPath}?${qs.toString()}`);
    },
    [toolsPath, navigate],
  );

  // "What was actually on screen then?" — the question this table could never answer.
  const openInRecall = useCallback(
    (iso: string) => navigate(agentRecallHref(iso, toolsPath)),
    [toolsPath, navigate],
  );

  const columns = useMemo(
    () => windowColumns(agentId, openInActivity, openInRecall),
    [agentId, openInActivity, openInRecall],
  );
  const table = useDataTable({
    data: items,
    columns,
    initialSorting: [{ id: "timestamp", desc: true }],
    filterFn: matchesWindow,
  });
  const filteringText = String(table.state.globalFilter ?? "");

  if (!activeWindowAvailable) {
    return (
      <CapabilityNotice
        info={agentInfo}
        capability="active_window"
        title="Window tracking unavailable"
      />
    );
  }

  const failed = windowsQuery.isError;
  const topChips = topItems.filter((t) => t.title.trim() || t.app).slice(0, TOP_CHIPS);

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card/10">
      <MonitoringToolbar
        title="App windows"
        searchLabel="Search windows"
        placeholder="Search windows"
        query={filteringText}
        onQueryChange={table.setGlobalFilter}
        count={listCountLabel({
          shown: table.getFilteredRowModel().rows.length,
          loaded: items.length,
          limit: WINDOWS_LIMIT,
          noun: FOCUS_EVENTS,
        })}
        onRefresh={fetchWindows}
        refreshing={loading && items.length > 0}
      />
      {topChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-4 pt-2 sm:px-5">
          <span className="text-[13px] text-muted-foreground">Most focused</span>
          {topChips.map((t) => {
            const label = titleRestatesApp(t.title, t.app_display, t.app)
              ? prettyAppLabel({ exeName: t.app, appDisplay: t.app_display })
              : t.title;
            const query = t.title.trim() || t.app;
            const active = filteringText === query;
            return (
              <Button
                key={`${t.app}|${t.title}`}
                variant={active ? "secondary" : "outline"}
                size="sm"
                className="h-7 max-w-64 gap-1.5 pointer-coarse:h-9"
                aria-pressed={active}
                title={`${label} · focused ${t.focus_count} times. ${active ? "Show everything again" : "Only show this"}`}
                onClick={() => table.setGlobalFilter(active ? "" : query)}
              >
                <AppIcon agentId={agentId} exeName={t.app} size={14} />
                <span className="truncate">{label}</span>
                <span className="text-muted-foreground tabular-nums">{t.focus_count}</span>
              </Button>
            );
          })}
        </div>
      )}
      {failed ? <LoadFailed what="window history" onRetry={fetchWindows} /> : null}
      <div className="px-2 py-2">
        <DataTable
          dayGroupColumn="timestamp"
          table={table}
          loading={loading}
          loadingText="Loading windows…"
          emptyText={
            failed
              ? "Nothing to show."
              : filteringText
                ? "No windows match this search."
                : "No windows recorded yet."
          }
          bodyClassName="[&_td]:align-top"
        />
      </div>
      <div className="border-t border-foreground/[0.06] px-5 py-1 empty:hidden">
        <DataTablePagination table={table} />
      </div>
    </div>
  );
}
