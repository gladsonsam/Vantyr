import { Search, X, RefreshCw } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@vantyr/ui/components/input-group";
import { DataTable } from "@/components/common/data-table/DataTable";
import { DataTableColumnHeader } from "@/components/common/data-table/DataTableColumnHeader";
import { DataTablePagination } from "@/components/common/data-table/DataTablePagination";
import { createDataTableColumns } from "@/components/common/data-table/features";
import { useDataTable } from "@/components/common/data-table/useDataTable";
import { useCallback, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { agentQueries } from "@/api/queries/agents";
import { fmtDateTime } from "@/lib/utils";
import { prettyAppLabel } from "@/lib/appNames";
import { AppIcon } from "@/components/common/AppIcon";
import { applyActivityStateToSearchParams } from "@/features/activity/activityUrl";
import { agentRecallHref } from "@/features/recall/lib/recallUrl";
import type { AgentInfo, WindowEvent as WindowEventRow, WindowTopRow } from "@/api/types";
import { capabilityAvailable } from "@/features/agent-detail/lib/agentCapabilities";
import { CapabilityNotice } from "@/features/agent-detail/components/CapabilityNotice";

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
      meta: { className: "whitespace-nowrap" },
    }),
    columnHelper.accessor("timestamp", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Time" />,
      cell: ({ row }) => fmtDateTime(row.original.timestamp),
      meta: { className: "whitespace-nowrap font-mono text-xs tabular-nums" },
    }),
    columnHelper.accessor("exe_name", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Application" />,
      cell: ({ row, table }) => {
        const item = row.original;
        return (
          <>
            <div className="flex items-center gap-2">
              <AppIcon agentId={agentId} exeName={item.exe_name} size={16} />
              <button
                type="button"
                onClick={() => table.setGlobalFilter(item.exe_name ?? "")}
                title="Filter table by this app"
                className="inline-flex min-h-6 cursor-pointer items-center p-0 text-left hover:underline"
              >
                {prettyAppLabel({ exeName: item.exe_name, appDisplay: item.app_display })}
              </button>
            </div>
            <div className="font-mono text-xs text-muted-foreground">
              {item.exe_name}
            </div>
          </>
        );
      },
    }),
    columnHelper.accessor("window_title", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Window Title" />,
      cell: ({ row }) => {
        const item = row.original;
        return (
          <div className="flex items-start justify-between gap-2.5">
            <span className="min-w-0 wrap-break-word">{item.window_title || "—"}</span>
            <span className="flex shrink-0 gap-2">
              {item.window_title?.trim() ? (
                <Button variant="link" size="sm" className="h-auto p-0" onClick={() => openInActivity(item.window_title)}>
                  Activity
                </Button>
              ) : null}
              {item.timestamp ? (
                <Button variant="link" size="sm" className="h-auto p-0" onClick={() => openInRecall(item.timestamp)}>
                  Recall
                </Button>
              ) : null}
            </span>
          </div>
        );
      },
    }),
  ]);
}

const WINDOWS_PAGE = { limit: 500 };
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
      { ...agentQueries.windows(agentId, WINDOWS_PAGE), enabled: activeWindowAvailable, select: toWindowEvents },
      { ...agentQueries.topWindows(agentId, TOP_WINDOWS_PAGE), enabled: activeWindowAvailable, select: toTopWindows },
    ],
  });
  const items = windowsQuery.data ?? NO_WINDOWS;
  const topItems = topWindowsQuery.data ?? NO_TOP_WINDOWS;
  const loading = windowsQuery.isFetching || topWindowsQuery.isFetching;
  const fetchWindows = () => {
    void windowsQuery.refetch();
    void topWindowsQuery.refetch();
  };

  const openInActivity = useCallback(
    (q: string) => {
      const qs = applyActivityStateToSearchParams(new URLSearchParams(), { v: 1, q });
      navigate(`/agents/${agentId}?${qs.toString()}`);
    },
    [agentId, navigate],
  );

  // "What was actually on screen then?" — the question this table could never answer.
  const openInRecall = useCallback(
    (iso: string) => navigate(agentRecallHref(agentId, iso)),
    [agentId, navigate],
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
    return <CapabilityNotice info={agentInfo} capability="active_window" title="Window tracking unavailable" />;
  }

  return (
    <div className="overflow-hidden rounded-xl bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="font-heading text-base font-medium">
            Focus events{" "}
            <span className="font-mono text-sm text-muted-foreground">({items.length})</span>
          </h2>
          {topItems.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {`Top: ${topItems
                .slice(0, 2)
                .map((t) => `${prettyAppLabel({ exeName: t.app, appDisplay: t.app_display })} (${t.focus_count})`)
                .join(" • ")}`}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => void fetchWindows()}>
          <RefreshCw /> Refresh
        </Button>
      </div>
      <div className="px-5 pt-3">
        <InputGroup className="h-9">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search windows"
            placeholder="App or window title"
            value={filteringText}
            onChange={(e) => table.setGlobalFilter(e.target.value)}
          />
          {filteringText && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label="Clear search"
                onClick={() => table.setGlobalFilter("")}
              >
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
      </div>
      <div className="px-2 py-2">
        <DataTable
          table={table}
          loading={loading}
          loadingText="Loading windows…"
          emptyText="No windows yet"
          bodyClassName="[&_td]:align-top"
        />
      </div>
      <div className="border-t border-foreground/[0.06] px-5 py-1 empty:hidden">
        <DataTablePagination table={table} />
      </div>
    </div>
  );
}
