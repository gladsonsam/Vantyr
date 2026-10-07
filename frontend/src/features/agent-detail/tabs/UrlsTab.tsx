import { Search, X, RefreshCw } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vantyr/ui/components/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@vantyr/ui/components/input-group";
import { DataTable } from "@/components/common/data-table/DataTable";
import { DataTableColumnHeader } from "@/components/common/data-table/DataTableColumnHeader";
import { DataTablePagination } from "@/components/common/data-table/DataTablePagination";
import { createDataTableColumns } from "@/components/common/data-table/features";
import { useDataTable } from "@/components/common/data-table/useDataTable";
import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "@/api";
import { agentKeys, agentQueries } from "@/api/queries/agents";
import { fmtDateTime } from "@/lib/utils";
import { applyActivityStateToSearchParams } from "@/features/activity/activityUrl";
import { agentRecallHref } from "@/features/recall/lib/recallUrl";
import { VI } from "@/components/common/Icons";
import { AppIcon } from "@/components/common/AppIcon";
import type { AgentInfo, UrlVisit } from "@/api/types";
import { capabilityAvailable } from "@/features/agent-detail/lib/agentCapabilities";
import { CapabilityNotice } from "@/features/agent-detail/components/CapabilityNotice";
import { isAdminRole } from "@/features/auth/permissions";
import type { DashboardRole } from "@/api/types";

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

function normalizeHref(value: string | undefined): string {
  const raw = (value || "").trim();
  if (!raw) return "#";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function matchesUrl(item: URLEvent, filteringText: string): boolean {
  const searchText = filteringText.toLowerCase();
  return (
    (item.url || "").toLowerCase().includes(searchText) ||
    (item.browser || "").toLowerCase().includes(searchText) ||
    (item.category || "").toLowerCase().includes(searchText) ||
    (item.user || "").toLowerCase().includes(searchText)
  );
}

const URLS_PAGE = { limit: 500 };
const NO_URLS: URLEvent[] = [];

function toUrlEvents({ rows }: { rows: UrlVisit[] }): URLEvent[] {
  return rows.map((row) => ({
    id: row.id ?? 0,
    url: row.url ?? "",
    browser: row.browser ?? "—",
    timestamp: row.ts ?? "",
    user: row.user ?? null,
    category: row.category ?? null,
  }));
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
      meta: { className: "whitespace-nowrap" },
    }),
    columnHelper.accessor("timestamp", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Time" />,
      cell: ({ row }) => fmtDateTime(row.original.timestamp),
      meta: { className: "whitespace-nowrap font-mono text-xs tabular-nums" },
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
      meta: { className: "whitespace-nowrap" },
    }),
    columnHelper.accessor((item) => item.category ?? undefined, {
      id: "category",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Category" />,
      cell: ({ row }) => row.original.category || "—",
      meta: { className: "whitespace-nowrap" },
    }),
    columnHelper.accessor("url", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="URL" />,
      cell: ({ row }) => {
        const item = row.original;
        return (
          <div className="flex min-w-0 items-center justify-between gap-2.5">
            <span className="min-w-0 flex-1 truncate">
              <a
                href={normalizeHref(item.url)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[13px] text-primary hover:underline"
              >
                {item.url || "—"}
              </a>
            </span>
            <span className="flex shrink-0 gap-2">
              {item.url.trim() ? (
                <Button variant="link" size="sm" className="h-auto p-0" onClick={() => openInActivity(item.url)}>
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

  const hasUncategorized = useMemo(
    () => items.some((r) => (r.category ?? "").trim() === ""),
    [items]
  );

  if (!urlTrackingAvailable) {
    return <CapabilityNotice info={agentInfo} capability="url_tracking" title="URL tracking unavailable" />;
  }

  return (
    <div className="overflow-hidden rounded-xl bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
        <h2 className="font-heading text-base font-medium">
          Visits{" "}
          <span className="font-mono text-sm text-muted-foreground">({items.length})</span>
        </h2>
        <div className="flex items-center gap-2">
          {canAdmin && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
                Maintenance
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={!hasUncategorized || backfill.isPending}
                  title={!hasUncategorized ? "Nothing to categorize." : undefined}
                  onClick={() => { if (canAdmin) backfill.mutate(); }}
                >
                  {backfill.isPending ? "Categorizing…" : "Categorize history"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button variant="outline" size="sm" onClick={() => void urlsQuery.refetch()}>
            <RefreshCw /> Refresh
          </Button>
        </div>
      </div>
      <div className="px-5 pt-3">
        <InputGroup className="h-9">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search URLs"
            placeholder="URL or browser"
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
          loadingText="Loading URLs…"
          emptyText="No visits yet"
          bodyClassName="[&_td]:align-top"
        />
      </div>
      <div className="border-t border-foreground/[0.06] px-5 py-1">
        <DataTablePagination table={table} />
      </div>
    </div>
  );
}
