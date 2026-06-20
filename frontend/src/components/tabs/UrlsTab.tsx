import { Table, Box, Header, Pagination, TextFilter, Button, ButtonDropdown, Link } from "../ui/console";
import { useCollection } from "../../hooks/useCollection";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { fmtDateTime } from "../../lib/utils";
import { applyActivityStateToSearchParams } from "../../lib/activityUrl";
import { VI } from "../common/Icons";
import { AppIcon } from "../common/AppIcon";
import type { AgentInfo } from "../../lib/types";
import { capabilityAvailable } from "../../lib/agentCapabilities";
import { CapabilityNotice } from "../common/CapabilityNotice";

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
}

function normalizeHref(value: string | undefined): string {
  const raw = (value || "").trim();
  if (!raw) return "#";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

export function UrlsTab({ agentId, agentInfo }: UrlsTabProps) {
  const navigate = useNavigate();
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

  useEffect(() => {
    void fetchUrls();
  }, [fetchUrls]);

  useEffect(() => {
    const onChanged = () => void fetchUrls();
    window.addEventListener("vantyr.urlCategoriesChanged", onChanged as EventListener);
    return () => window.removeEventListener("vantyr.urlCategoriesChanged", onChanged as EventListener);
  }, [fetchUrls]);

  const backfill = async () => {
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
    <Table
      {...collectionProps}
      loading={loading}
      loadingText="Loading URLs..."
      minWidth={820}
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
          id: "browser",
          header: "Browser",
          cell: (item) => {
            const exeName = browserToExe(item.browser);
            return (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ position: "relative", width: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <VI.globe style={{ width: 14, height: 14, color: "var(--tx-3)", position: "absolute" }} />
                  {exeName && (
                    <div style={{ position: "absolute", zIndex: 1, display: "flex" }}>
                      <AppIcon agentId={agentId} exeName={exeName} size={16} />
                    </div>
                  )}
                </div>
                <span>{item.browser || "—"}</span>
              </div>
            );
          },
          sortingField: "browser",
          width: 170,
        },
        {
          id: "category",
          header: "Category",
          cell: (item) => item.category || "—",
          sortingField: "category",
          width: 160,
        },
        {
          id: "url",
          header: "URL",
          cell: (item) => (
            <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", minWidth: 0 }}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <Link href={normalizeHref(item.url)} external fontSize="body-s">
                  {item.url || "—"}
                </Link>
              </span>
              {item.url.trim() ? (
                <Button variant="inline-link" onClick={() => openInActivity(item.url)}>
                  Activity
                </Button>
              ) : null}
            </div>
          ),
          sortingField: "url",
        },
      ]}
      items={displayItems}
      variant="container"
      stickyHeader
      header={
        <Header
          counter={`(${items.length})`}
          actions={
            <>
              <ButtonDropdown
                items={[
                  {
                    id: "backfill",
                    text: "Categorize existing URL history",
                    disabled: !hasUncategorized || backfillLoading,
                    disabledReason: !hasUncategorized ? "No uncategorized URL rows in this view." : undefined,
                  },
                ]}
                onItemClick={({ detail }) => {
                  if (detail.id === "backfill") void backfill();
                }}
                loading={backfillLoading}
              >
                Maintenance
              </ButtonDropdown>
              <Button iconName="refresh" onClick={fetchUrls}>
                Refresh
              </Button>
            </>
          }
        >
          URL History
        </Header>
      }
      filter={
        <TextFilter
          {...filterProps}
          filteringPlaceholder="Search by URL or browser"
        />
      }
      pagination={<Pagination {...paginationProps} />}
      empty={
        <Box textAlign="center" color="inherit">
          <Box variant="p" color="inherit">
            No URL visits recorded
          </Box>
        </Box>
      }
    />
  );
}
