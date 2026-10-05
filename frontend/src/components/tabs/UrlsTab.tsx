import { Search, X, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCollection, type UseCollectionCollectionProps } from "../../hooks/useCollection";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { fmtDateTime } from "../../lib/utils";
import { applyActivityStateToSearchParams } from "../../lib/activityUrl";
import { agentRecallHref } from "../../lib/recallUrl";
import { VI } from "../common/Icons";
import { AppIcon } from "../common/AppIcon";
import type { AgentInfo } from "../../lib/types";
import { capabilityAvailable } from "../../lib/agentCapabilities";
import { CapabilityNotice } from "../common/CapabilityNotice";
import { isAdminRole } from "../../lib/permissions";
import type { DashboardRole } from "../../lib/types";

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

function Pager({ currentPageIndex, pagesCount, onChange }: {
  currentPageIndex: number;
  pagesCount: number;
  onChange: (event: { detail: { currentPageIndex: number } }) => void;
}) {
  return (
    <div className="flex items-center justify-center gap-2 py-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={currentPageIndex <= 1}
        onClick={() => onChange({ detail: { currentPageIndex: currentPageIndex - 1 } })}
      >
        Previous
      </Button>
      <span className="px-3 text-[13px] text-muted-foreground tabular-nums">
        Page {currentPageIndex} of {pagesCount}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={currentPageIndex >= pagesCount}
        onClick={() => onChange({ detail: { currentPageIndex: currentPageIndex + 1 } })}
      >
        Next
      </Button>
    </div>
  );
}

function SortTh({ label, field, collectionProps }: {
  label: string;
  field: string;
  collectionProps: UseCollectionCollectionProps;
}) {
  const { sortingColumn, isDescending, onSortingChange } = collectionProps;
  const active = sortingColumn?.sortingField === field;
  return (
    <TableHead aria-sort={active ? (isDescending ? "descending" : "ascending") : undefined}>
      <button
        type="button"
        onClick={() => onSortingChange({
          detail: {
            sortingColumn: { sortingField: field },
            isDescending: active ? !isDescending : false,
          },
        })}
        className="inline-flex items-center gap-1.5 hover:text-foreground"
        aria-label={`Sort by ${label}`}
      >
        {label}
        {active && <span aria-hidden="true">{isDescending ? "↓" : "↑"}</span>}
      </button>
    </TableHead>
  );
}

export function UrlsTab({ agentId, agentInfo, dashboardRole = null }: UrlsTabProps) {
  const navigate = useNavigate();
  const canAdmin = isAdminRole(dashboardRole);
  const [items, setItems] = useState<URLEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [backfillLoading, setBackfillLoading] = useState(false);
  const urlTrackingAvailable = capabilityAvailable(agentInfo, "url_tracking");

  const fetchUrls = useCallback(async () => {
    if (!urlTrackingAvailable) {
      setItems([]);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const urls = await api.urls(agentId, { limit: 500 });

      setItems(
        urls.rows.map((row) => ({
          id: row.id ?? 0,
          url: row.url ?? "",
          browser: row.browser ?? "—",
          timestamp: row.ts ?? "",
          user: row.user ?? null,
          category: row.category ?? null,
        })),
      );
    } catch (err) {
      console.error("Failed to fetch URLs:", err);
    } finally {
      setLoading(false);
    }
  }, [agentId, urlTrackingAvailable]);

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

  useEffect(() => {
    void fetchUrls();
  }, [fetchUrls]);

  useEffect(() => {
    const onChanged = () => void fetchUrls();
    window.addEventListener("vantyr.urlCategoriesChanged", onChanged as EventListener);
    return () => window.removeEventListener("vantyr.urlCategoriesChanged", onChanged as EventListener);
  }, [fetchUrls]);

  const backfill = async () => {
    // Backend: POST /agents/:id/url-category-backfill is admin-only.
    if (!canAdmin) return;
    setBackfillLoading(true);
    try {
      await api.agentUrlCategoryBackfill(agentId, { limit: 25_000 });
      window.setTimeout(() => { void fetchUrls(); }, 1200);
    } catch (e) {
      console.error("Backfill failed:", e);
    } finally {
      setBackfillLoading(false);
    }
  };

  const { items: displayItems, collectionProps, filterProps, paginationProps } = useCollection(
    items,
    {
      filtering: {
        empty: "No URLs found",
        noMatch: "No URLs match the filter",
        filteringFunction: (item, filteringText) => {
          const searchText = filteringText.toLowerCase();
          return (
            (item.url || "").toLowerCase().includes(searchText) ||
            (item.browser || "").toLowerCase().includes(searchText) ||
            (item.category || "").toLowerCase().includes(searchText) ||
            (item.user || "").toLowerCase().includes(searchText)
          );
        },
      },
      pagination: { pageSize: 50 },
      sorting: {
        defaultState: {
          sortingColumn: { sortingField: "timestamp" },
          isDescending: true,
        },
      },
    }
  );

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
          URL History{" "}
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
                  disabled={!hasUncategorized || backfillLoading}
                  title={!hasUncategorized ? "No uncategorized URL rows in this view." : undefined}
                  onClick={() => void backfill()}
                >
                  {backfillLoading ? "Categorizing…" : "Categorize existing URL history"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button variant="outline" size="sm" onClick={() => void fetchUrls()}>
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
            placeholder="Search by URL or browser"
            value={filterProps.filteringText}
            onChange={(e) => filterProps.onChange({ detail: { filteringText: e.target.value } })}
          />
          {filterProps.filteringText && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label="Clear search"
                onClick={() => filterProps.onChange({ detail: { filteringText: "" } })}
              >
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
      </div>
      <div className="px-2 py-2">
        <Table>
          <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
            <TableRow className="hover:bg-transparent">
              <SortTh label="User" field="user" collectionProps={collectionProps} />
              <SortTh label="Time" field="timestamp" collectionProps={collectionProps} />
              <SortTh label="Browser" field="browser" collectionProps={collectionProps} />
              <SortTh label="Category" field="category" collectionProps={collectionProps} />
              <SortTh label="URL" field="url" collectionProps={collectionProps} />
            </TableRow>
          </TableHeader>
          <TableBody className="[&_td]:px-3 [&_td]:py-3.5 [&_td]:align-top">
            {loading && displayItems.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5}>
                  <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                    <Spinner /> Loading URLs…
                  </div>
                </TableCell>
              </TableRow>
            ) : displayItems.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5}>
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No URL visits recorded
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              displayItems.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="whitespace-nowrap">{item.user || "—"}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums">{fmtDateTime(item.timestamp)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {(() => {
                      const exeName = browserToExe(item.browser);
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
                          <span>{item.browser || "—"}</span>
                        </div>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{item.category || "—"}</TableCell>
                  <TableCell>
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
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <div className="border-t border-foreground/[0.06] px-5 py-1">
        <Pager {...paginationProps} />
      </div>
    </div>
  );
}
