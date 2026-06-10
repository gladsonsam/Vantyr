import { Table, Box, Header, Pagination, TextFilter, Button, useCollection } from "../ui/console";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { fmtDateTime } from "../../lib/utils";
import { prettyAppLabel } from "../../lib/app-names";
import { AppIcon } from "../common/AppIcon";
import { applyActivityStateToSearchParams } from "../../lib/activityUrl";

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
  title: string;
  focus_count: number;
  last_ts: string;
}

interface WindowsTabProps {
  agentId: string;
}

export function WindowsTab({ agentId }: WindowsTabProps) {
  const navigate = useNavigate();
  const [items, setItems] = useState<WindowEvent[]>([]);
  const [topItems, setTopItems] = useState<TopWindowRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchWindows = useCallback(async () => {
    try {
      setLoading(true);
      const [{ rows }, top] = await Promise.all([
        api.windows(agentId, { limit: 500 }),
        api.topWindows(agentId, { limit: 20 }),
      ]);

      setItems(
        rows.map((row) => ({
          id: row.hwnd ?? 0,
          window_title: row.title ?? "—",
          exe_name: row.app ?? "—",
          app_display: row.app ?? "—",
          timestamp: row.ts || row.created || "",
          user: row.user ?? null,
        })),
      );

      setTopItems(
        top.rows.map((row) => ({
          app: row.app ?? "",
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
  }, [agentId]);

  const openInActivity = useCallback(
    (q: string) => {
      const qs = applyActivityStateToSearchParams(new URLSearchParams(), { v: 1, q });
      navigate(`/agents/${agentId}?${qs.toString()}`);
    },
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

  return (
    <Table
      {...collectionProps}
      loading={loading}
      loadingText="Loading windows..."
      columnDefinitions={[
        {
          id: "user",
          header: "User",
          cell: (item) => item.user || "—",
          sortingField: "user",
          width: 160,
        },
        {
          id: "timestamp",
          header: "Time",
          cell: (item) => fmtDateTime(item.timestamp),
          sortingField: "timestamp",
          width: 180,
        },
        {
          id: "app",
          header: "Application",
          cell: (item) => (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <AppIcon agentId={agentId} exeName={item.exe_name} size={16} />
                <button
                  type="button"
                  onClick={() =>
                    filterProps.onChange({
                      detail: { filteringText: item.exe_name ?? "" },
                    } as Parameters<typeof filterProps.onChange>[0])
                  }
                  title="Filter table by this app"
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: "inherit",
                    textAlign: "left",
                    font: "inherit",
                  }}
                >
                  {prettyAppLabel({ exeName: item.exe_name, appDisplay: item.app_display })}
                </button>
              </div>
              <Box className="vantyr-monospace" fontSize="body-s" color="text-body-secondary">
                {item.exe_name}
              </Box>
            </div>
          ),
          sortingField: "exe_name",
          width: 200,
        },
        {
          id: "window",
          header: "Window Title",
          cell: (item) => (
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start", justifyContent: "space-between", minWidth: 0 }}>
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{item.window_title || "—"}</span>
              {item.window_title?.trim() ? (
                <Button variant="inline-link" onClick={() => openInActivity(item.window_title)}>
                  Activity
                </Button>
              ) : null}
            </div>
          ),
          sortingField: "window_title",
        },
      ]}
      items={displayItems}
      variant="container"
      stickyHeader
      header={
        <Header
          counter={`(${items.length})`}
          actions={
            <Button iconName="refresh" onClick={fetchWindows}>
              Refresh
            </Button>
          }
          description={
            topItems.length > 0
              ? `Top windows retained long-term: ${topItems
                  .slice(0, 2)
                  .map((t) => `${prettyAppLabel({ exeName: t.app })} (${t.focus_count})`)
                  .join(" • ")}`
              : "Top window aggregates are retained after raw windows retention expiry."
          }
        >
          Window Focus History
        </Header>
      }
      filter={
        <TextFilter
          {...filterProps}
          filteringPlaceholder="Search by app or window title"
        />
      }
      pagination={<Pagination {...paginationProps} />}
      empty={
        <Box textAlign="center" color="inherit">
          <Box variant="p" color="inherit">
            No window focus events recorded
          </Box>
        </Box>
      }
    />
  );
}
