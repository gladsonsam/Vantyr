import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Table from "@cloudscape-design/components/table";
import Box from "@cloudscape-design/components/box";
import Header from "@cloudscape-design/components/header";
import Pagination from "@cloudscape-design/components/pagination";
import TextFilter from "@cloudscape-design/components/text-filter";
import Button from "@cloudscape-design/components/button";
import ButtonDropdown from "@cloudscape-design/components/button-dropdown";
import Link from "@cloudscape-design/components/link";
import { useCollection } from "@cloudscape-design/collection-hooks";
import { api } from "../../lib/api";
import { fmtDateTime } from "../../lib/utils";
import { applyActivityStateToSearchParams } from "../../lib/activityUrl";

interface URLEvent {
  id: number;
  url: string;
  browser: string;
  timestamp: string;
  user?: string | null;
  category?: string | null;
}

interface TopUrlRow {
  url: string;
  visit_count: number;
  last_ts: string;
}

interface UrlsTabProps {
  agentId: string;
}

function normalizeHref(value: string | undefined): string {
  const raw = (value || "").trim();
  if (!raw) return "#";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function hostnameFromUrl(url: string): string {
  const raw = url.trim();
  if (!raw) return "";
  try {
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(href).hostname;
  } catch {
    return raw.split(/[/:?#]/)[0] || raw;
  }
}

/** Distinct hostnames in server top-URL order, up to `max` entries. */
function topHostnamesFromRows(rows: TopUrlRow[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const host = hostnameFromUrl(row.url);
    const key = host.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(host);
    if (out.length >= max) break;
  }
  return out;
}

export function UrlsTab({ agentId }: UrlsTabProps) {
  const navigate = useNavigate();
  const [items, setItems] = useState<URLEvent[]>([]);
  const [topItems, setTopItems] = useState<TopUrlRow[]>([]);
  const [categoryStats, setCategoryStats] = useState<{ category: string; visit_count: number; last_ts: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [backfillLoading, setBackfillLoading] = useState(false);

  const fetchUrls = useCallback(async () => {
    try {
      setLoading(true);
      const [urls, top, cats] = await Promise.all([
        api.urls(agentId, { limit: 500 }),
        api.topUrls(agentId, { limit: 20 }),
        api.agentUrlCategoryStats(agentId, { limit: 12 }),
      ]);

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

      setTopItems(
        top.rows.map((row) => ({
          url: row.url ?? "",
          visit_count: row.visit_count ?? 0,
          last_ts: row.last_ts ?? "",
        })),
      );

      setCategoryStats(
        (cats.rows ?? []).map((row) => ({
          category: row.category ?? "",
          visit_count: row.visit_count ?? 0,
          last_ts: row.last_ts ?? "",
        })),
      );
    } catch (err) {
      console.error("Failed to fetch URLs:", err);
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
    void fetchUrls();
  }, [fetchUrls]);

  useEffect(() => {
    const onChanged = () => void fetchUrls();
    window.addEventListener("sentinel.urlCategoriesChanged", onChanged as EventListener);
    return () => window.removeEventListener("sentinel.urlCategoriesChanged", onChanged as EventListener);
  }, [fetchUrls]);

  const backfill = async () => {
    setBackfillLoading(true);
    try {
      await api.agentUrlCategoryBackfill(agentId, { limit: 25_000 });
      // Give the worker a moment, then refresh.
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

  const headerDescription = useMemo(() => {
    const hosts = topHostnamesFromRows(topItems, 6);
    const cats = categoryStats
      .filter((r) => (r.category || "").trim() !== "" && Number.isFinite(r.visit_count) && r.visit_count > 0)
      .slice(0, 6)
      .map((r) => `${r.category} (${r.visit_count})`);
    if (cats.length > 0 && hosts.length > 0) {
      return `Top categories: ${cats.join(" • ")}. Top hostnames retained long-term: ${hosts.join(" • ")}`;
    }
    if (cats.length > 0) {
      return `Top categories: ${cats.join(" • ")}`;
    }
    return hosts.length > 0
      ? `Top hostnames retained long-term: ${hosts.join(" • ")}`
      : "Top URL aggregates are retained after raw URL retention expiry.";
  }, [topItems, categoryStats]);

  const hasUncategorized = useMemo(
    () => items.some((r) => (r.category ?? "").trim() === ""),
    [items]
  );

  return (
    <Table
      {...collectionProps}
      loading={loading}
      loadingText="Loading URLs..."
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
          cell: (item) => item.browser || "—",
          sortingField: "browser",
          width: 150,
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
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start", justifyContent: "space-between", minWidth: 0 }}>
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
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
          description={headerDescription}
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
