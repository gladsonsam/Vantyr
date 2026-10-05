import { Search, X, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCollection, type UseCollectionCollectionProps } from "../../hooks/useCollection";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { fmtDateTime } from "../../lib/utils";
import { prettyAppLabel } from "../../lib/app-names";
import { AppIcon } from "../common/AppIcon";
import { applyActivityStateToSearchParams } from "../../lib/activityUrl";
import { agentRecallHref } from "../../lib/recallUrl";
import type { AgentInfo } from "../../lib/types";
import { capabilityAvailable } from "../../lib/agentCapabilities";
import { CapabilityNotice } from "../common/CapabilityNotice";

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

export function WindowsTab({ agentId, agentInfo }: WindowsTabProps) {
  const navigate = useNavigate();
  const [items, setItems] = useState<WindowEvent[]>([]);
  const [topItems, setTopItems] = useState<TopWindowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const activeWindowAvailable = capabilityAvailable(agentInfo, "active_window");

  const fetchWindows = useCallback(async () => {
    if (!activeWindowAvailable) {
      setItems([]);
      setTopItems([]);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const [{ rows }, top] = await Promise.all([
        api.windows(agentId, { limit: 500 }),
        api.topWindows(agentId, { limit: 20 }),
      ]);

      setItems(
        rows.map((row, i) => ({
          // `hwnd` is a window handle, not an event id: the same window focused
          // repeatedly yields the same hwnd, so using it as the row key collides
          // (React duplicate-key warning, and rows can be dropped on re-render).
          // The endpoint returns no per-row id, so key on position.
          id: i + 1,
          window_title: row.title ?? "—",
          exe_name: row.app ?? "—",
          app_display: row.app_display?.trim() ? row.app_display : (row.app ?? "—"),
          timestamp: row.ts || row.created || "",
          user: row.user ?? null,
        })),
      );

      setTopItems(
        top.rows.map((row) => ({
          app: row.app ?? "",
          app_display: row.app_display ?? "",
          title: row.title ?? "",
          focus_count: row.focus_count ?? 0,
          last_ts: row.last_ts ?? "",
        })),
      );
    } catch (err) {
      console.error("Failed to fetch windows:", err);
    } finally {
      setLoading(false);
    }
  }, [agentId, activeWindowAvailable]);

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
    void fetchWindows();
  }, [fetchWindows]);

  const { items: displayItems, collectionProps, filterProps, paginationProps } = useCollection(
    items,
    {
      filtering: {
        empty: "No windows found",
        noMatch: "No windows match the filter",
        filteringFunction: (item, filteringText) => {
          const searchText = filteringText.toLowerCase();
          return (
              (item.app_display || "").toLowerCase().includes(searchText) ||
            (item.exe_name || "").toLowerCase().includes(searchText) ||
          (item.window_title || "").toLowerCase().includes(searchText) ||
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

  if (!activeWindowAvailable) {
    return <CapabilityNotice info={agentInfo} capability="active_window" title="Window tracking unavailable" />;
  }

  return (
    <div className="overflow-hidden rounded-xl bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="font-heading text-base font-medium">
            Window Focus History{" "}
            <span className="font-mono text-sm text-muted-foreground">({items.length})</span>
          </h2>
          <p className="text-sm text-muted-foreground">
            {topItems.length > 0
              ? `Top windows retained long-term: ${topItems
                  .slice(0, 2)
                  .map((t) => `${prettyAppLabel({ exeName: t.app, appDisplay: t.app_display })} (${t.focus_count})`)
                  .join(" • ")}`
              : "Top window aggregates are retained after raw windows retention expiry."}
          </p>
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
            placeholder="Search by app or window title"
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
              <SortTh label="Application" field="exe_name" collectionProps={collectionProps} />
              <SortTh label="Window Title" field="window_title" collectionProps={collectionProps} />
            </TableRow>
          </TableHeader>
          <TableBody className="[&_td]:px-3 [&_td]:py-3.5 [&_td]:align-top">
            {loading && displayItems.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4}>
                  <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                    <Spinner /> Loading windows…
                  </div>
                </TableCell>
              </TableRow>
            ) : displayItems.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4}>
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No window focus events recorded
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              displayItems.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="whitespace-nowrap">{item.user || "—"}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums">{fmtDateTime(item.timestamp)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <AppIcon agentId={agentId} exeName={item.exe_name} size={16} />
                      <button
                        type="button"
                        onClick={() =>
                          filterProps.onChange({
                            detail: { filteringText: item.exe_name ?? "" },
                          } as Parameters<typeof filterProps.onChange>[0])
                        }
                        title="Filter table by this app"
                        className="inline-flex min-h-6 cursor-pointer items-center p-0 text-left hover:underline"
                      >
                        {prettyAppLabel({ exeName: item.exe_name, appDisplay: item.app_display })}
                      </button>
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {item.exe_name}
                    </div>
                  </TableCell>
                  <TableCell>
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
