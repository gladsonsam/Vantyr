import { Activity, Check, Copy, History, MoreHorizontal } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vantyr/ui/components/dropdown-menu";
import { DataTable } from "@/components/common/data-table/DataTable";
import { DataTableColumnHeader } from "@/components/common/data-table/DataTableColumnHeader";
import { DataTablePagination } from "@/components/common/data-table/DataTablePagination";
import { createDataTableColumns } from "@/components/common/data-table/features";
import { useDataTable } from "@/components/common/data-table/useDataTable";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "@/api";
import { agentKeys, agentQueries } from "@/api/queries/agents";
import { applyActivityStateToSearchParams } from "@/features/activity/activityUrl";
import { agentRecallHref } from "@/features/recall/lib/recallUrl";
import { VI } from "@/components/common/Icons";
import { AppIcon } from "@/components/common/AppIcon";
import type { AgentInfo, UrlVisit } from "@/api/types";
import { capabilityAvailable } from "@/features/agent-detail/lib/agentCapabilities";
import { CapabilityNotice } from "@/features/agent-detail/components/CapabilityNotice";
import { isAdminRole } from "@/features/auth/permissions";
import type { DashboardRole } from "@/api/types";
import { LoadFailed, MonitoringToolbar, ROW_ACTIONS_CLASS, ROW_ACTION_BUTTON_CLASS } from "@/features/agent-detail/components/MonitoringToolbar";
import { categoryOf, listCountLabel, sharedValue, splitUrl } from "@/features/agent-detail/lib/monitoring";
import { copyToClipboard } from "@/lib/utils";
import { DayTimeCell } from "@/components/common/data-table/DayTimeCell";

function browserToExe(browserName: string | null | undefined): string | null {
  const norm = (browserName || "").toLowerCase().trim();
  if (norm.includes("chrome")) return "chrome.exe";
  if (norm.includes("edge")) return "msedge.exe";
  if (norm.includes("firefox")) return "firefox.exe";
  if (norm.includes("safari")) return "safari.exe";
  if (norm.includes("opera")) return "opera.exe";
  if (norm.includes("brave")) return "brave.exe";
  return null;
}

interface URLEvent {
  id: number;
  url: string;
  title: string;
  browser: string;
  timestamp: string;
  user?: string | null;
  category?: string | null;
}

interface UrlsTabProps {
  agentId: string;
  agentInfo?: AgentInfo | null;
  dashboardRole?: DashboardRole | null;
}

function matchesUrl(item: URLEvent, filteringText: string): boolean {
  const searchText = filteringText.toLowerCase();
  return (
    (item.url || "").toLowerCase().includes(searchText) ||
    (item.title || "").toLowerCase().includes(searchText) ||
    (item.browser || "").toLowerCase().includes(searchText) ||
    (item.category || "").toLowerCase().includes(searchText) ||
    (item.user || "").toLowerCase().includes(searchText)
  );
}

const URLS_LIMIT = 500;
const URLS_PAGE = { limit: URLS_LIMIT };
const NO_URLS: URLEvent[] = [];
const VISITS = { one: "visit", many: "visits" };

function toUrlEvents({ rows }: { rows: UrlVisit[] }): URLEvent[] {
  return rows.map((row) => ({
    id: row.id ?? 0,
    url: row.url ?? "",
    title: row.title?.trim() ?? "",
    browser: row.browser ?? "—",
    timestamp: row.ts ?? "",
    user: row.user ?? null,
    category: categoryOf(row.category) ?? null,
  }));
}

type UrlCopyState = "idle" | "copied" | "failed";

function useUrlCopy(url: string) {
  const [state, setState] = useState<UrlCopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    const ok = await copyToClipboard(url);
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1800);
  };
  return { state, copy };
}

/** Copies the full address with the same feedback as the phone menu. */
function CopyUrlButton({ state, onCopy }: { state: UrlCopyState; onCopy: () => void }) {
  return <Button variant="ghost" size="icon-sm" className={ROW_ACTION_BUTTON_CLASS}
    aria-label={state === "copied" ? "URL copied" : "Copy full URL"}
    title={state === "copied" ? "Copied" : "Copy full URL"} onClick={onCopy}>
    {state === "copied" ? <Check /> : <Copy />}
  </Button>;
}

/** Wide screens: three icon buttons. Phones: one menu, so the address keeps the width. */
function UrlRowActions({ item, openInActivity, openInRecall }: {
  item: URLEvent;
  openInActivity: (q: string) => void;
  openInRecall: (iso: string) => void;
}) {
  const { state: copyState, copy } = useUrlCopy(item.url);
  const hasUrl = item.url.trim() !== "";
  if (!hasUrl && !item.timestamp) return null;
  return (
    <span className={ROW_ACTIONS_CLASS}>
      <span className="flex items-center gap-0.5 max-sm:hidden">
        {hasUrl ? <CopyUrlButton state={copyState} onCopy={() => void copy()} /> : null}
        {hasUrl ? (
          <Button variant="ghost" size="icon-sm" className={ROW_ACTION_BUTTON_CLASS} aria-label="Show in timeline" title="Show in timeline" onClick={() => openInActivity(item.url)}>
            <Activity />
          </Button>
        ) : null}
        {item.timestamp ? (
          <Button variant="ghost" size="icon-sm" className={ROW_ACTION_BUTTON_CLASS} aria-label="Open in Recall" title="Open in Recall" onClick={() => openInRecall(item.timestamp)}>
            <History />
          </Button>
        ) : null}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className={`${ROW_ACTION_BUTTON_CLASS} sm:hidden`} aria-label="Visit actions" title="Visit actions" />}>
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {hasUrl ? <DropdownMenuItem onClick={() => void copy()}>Copy full URL</DropdownMenuItem> : null}
          {hasUrl ? <DropdownMenuItem onClick={() => openInActivity(item.url)}>Show in timeline</DropdownMenuItem> : null}
          {item.timestamp ? <DropdownMenuItem onClick={() => openInRecall(item.timestamp)}>Open in Recall</DropdownMenuItem> : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <span role="status" className={copyState === "idle" ? "sr-only" : "max-w-28 text-xs text-muted-foreground"}>
        {copyState === "copied" ? "Copied" : copyState === "failed" ? "Couldn’t copy URL" : ""}
      </span>
    </span>
  );
}

const columnHelper = createDataTableColumns<URLEvent>();

function urlColumns(
  agentId: string,
  openInActivity: (q: string) => void,
  openInRecall: (iso: string) => void,
) {
  return columnHelper.columns([
    columnHelper.accessor((item) => item.user ?? undefined, {
      id: "user",
      header: ({ column }) => <DataTableColumnHeader column={column} title="User" />,
      cell: ({ row }) => row.original.user || "—",
      // Every row has the same user on a single-user device; phones drop it.
      meta: { className: "whitespace-nowrap", hideWhenUniform: true },
    }),
    columnHelper.accessor("timestamp", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Time" />,
      cell: ({ row, table }) => <DayTimeCell table={table} columnId="timestamp" ts={row.original.timestamp} />,
      meta: { className: "whitespace-nowrap text-[13px] text-muted-foreground tabular-nums" },
    }),
    columnHelper.accessor("url", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Website" />,
      cell: ({ row }) => {
        const item = row.original;
        const { host, rest, href } = splitUrl(item.url);
        return (
          <div className="flex min-w-0 items-start justify-between gap-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-x-2 max-sm:flex-wrap">
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={item.url}
                  className="max-w-full shrink-0 truncate text-sm font-medium text-foreground hover:underline"
                >
                  {host || "—"}
                </a>
                {item.title ? <span className="truncate text-[13px] text-muted-foreground max-sm:basis-full">{item.title}</span> : null}
              </div>
              {rest ? (
                <div className="truncate text-xs text-muted-foreground" title={item.url}>
                  {rest}
                </div>
              ) : null}
            </div>
            <UrlRowActions key={`${item.id}:${item.url}:${item.timestamp}`} item={item} openInActivity={openInActivity} openInRecall={openInRecall} />
          </div>
        );
      },
      meta: { className: "w-full max-w-0 max-sm:order-first max-sm:basis-full" },
    }),
    columnHelper.accessor((item) => item.category ?? undefined, {
      id: "category",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Category" />,
      cell: ({ row }) => row.original.category ?? <span className="text-muted-foreground">—</span>,
      // Nothing categorised yet: a column of "Uncategorized" says nothing, so it stays hidden.
      meta: { className: "whitespace-nowrap", hideWhenUniform: true },
    }),
    columnHelper.accessor("browser", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Browser" />,
      cell: ({ row }) => {
        const exeName = browserToExe(row.original.browser);
        return (
          <div className="flex items-center gap-2">
            <div className="relative flex size-4 shrink-0 items-center justify-center">
              <VI.globe className="absolute size-3.5 text-muted-foreground" />
              {exeName && (
                <div className="absolute z-10 flex">
                  <AppIcon agentId={agentId} exeName={exeName} size={16} />
                </div>
              )}
            </div>
            <span>{row.original.browser || "—"}</span>
          </div>
        );
      },
      // One browser on every row is a fact about the list, not about each visit (see the line under the search).
      meta: { className: "whitespace-nowrap", hideWhenUniform: true },
    }),
  ]);
}

/** Admin-only history actions. */
function CategorizeMenu({ disabled, pending, onRun }: { disabled: boolean; pending: boolean; onRun: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More URL actions" title="More" />}>
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={disabled || pending}
          title={disabled ? "Nothing to categorize." : undefined}
          onClick={onRun}
        >
          {pending ? "Categorizing…" : "Categorize history"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What every visit has in common (columns that hide while rows agree leave their one value here). */
function SharedFacts({ values }: { values: string[] }) {
  return (
    <>
      {values.filter(Boolean).map((value) => (
        <span key={value}>· {value}</span>
      ))}
    </>
  );
}

export function UrlsTab({ agentId, agentInfo, dashboardRole = null }: UrlsTabProps) {
  const navigate = useNavigate();
  const canAdmin = isAdminRole(dashboardRole);
  const queryClient = useQueryClient();
  const urlTrackingAvailable = capabilityAvailable(agentInfo, "url_tracking");

  const urlsQuery = useQuery({
    ...agentQueries.urls(agentId, URLS_PAGE),
    enabled: urlTrackingAvailable,
    select: toUrlEvents,
  });
  const items = urlsQuery.data ?? NO_URLS;
  const loading = urlsQuery.isFetching;

  const backfill = useMutation({
    // Backend: POST /agents/:id/url-category-backfill is admin-only.
    mutationFn: () => api.agentUrlCategoryBackfill(agentId, { limit: 25_000 }),
    onSuccess: () => {
      // Categorization runs in the background; give it a moment before re-reading the list.
      window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: agentKeys.urls(agentId, URLS_PAGE) });
      }, 1200);
    },
    onError: (e) => console.error("Backfill failed:", e),
  });

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
    () => urlColumns(agentId, openInActivity, openInRecall),
    [agentId, openInActivity, openInRecall],
  );
  const table = useDataTable({
    data: items,
    columns,
    initialSorting: [{ id: "timestamp", desc: true }],
    filterFn: matchesUrl,
  });
  const filteringText = String(table.state.globalFilter ?? "");

  const hasUncategorized = useMemo(() => items.some((r) => !r.category), [items]);
  // Columns that hide while every row agrees still owe the reader that one value.
  const sharedBrowser = useMemo(() => sharedValue(items.map((r) => r.browser)), [items]);
  const sharedCategory = useMemo(() => sharedValue(items.map((r) => r.category ?? "")), [items]);

  if (!urlTrackingAvailable) {
    return <CapabilityNotice info={agentInfo} capability="url_tracking" title="URL tracking unavailable" />;
  }

  return (
    <div className="overflow-hidden rounded-xl bg-card">
      <MonitoringToolbar
        title="Websites visited"
        searchLabel="Search URLs"
        placeholder="Search websites"
        query={filteringText}
        onQueryChange={table.setGlobalFilter}
        count={listCountLabel({
          shown: table.getFilteredRowModel().rows.length,
          loaded: items.length,
          limit: URLS_LIMIT,
          noun: VISITS,
        })}
        detail={<SharedFacts values={[sharedBrowser === "—" ? "" : sharedBrowser, sharedCategory]} />}
        onRefresh={() => void urlsQuery.refetch()}
        refreshing={loading && items.length > 0}
        actions={
          canAdmin ? (
            <CategorizeMenu disabled={!hasUncategorized} pending={backfill.isPending} onRun={() => backfill.mutate()} />
          ) : null
        }
      />
      {urlsQuery.isError ? <LoadFailed what="website visits" onRetry={() => void urlsQuery.refetch()} /> : null}
      <div className="px-2 py-2">
        <DataTable dayGroupColumn="timestamp"
          table={table}
          loading={loading}
          loadingText="Loading websites…"
          emptyText={urlsQuery.isError ? "Nothing to show." : filteringText ? "No visits match this search." : "No websites visited yet."}
          bodyClassName="[&_td]:align-top"
        />
      </div>
      <div className="border-t border-foreground/[0.06] px-5 py-1 empty:hidden">
        <DataTablePagination table={table} />
      </div>
    </div>
  );
}
