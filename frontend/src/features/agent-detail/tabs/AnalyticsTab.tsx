import { api } from "@/api";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@vantyr/ui/components/card";
import { Spinner } from "@vantyr/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vantyr/ui/components/table";
import { ToggleGroup, ToggleGroupItem } from "@vantyr/ui/components/toggle-group";
import { X } from "lucide-react";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { analyticsKeys, analyticsQueries, type AnalyticsRange } from "@/api/queries/analytics";
import { cn, fmtDateTime, fmtFromNow, parseTimestamp } from "@/lib/utils";
import { isAdminRole } from "@/features/auth/permissions";
import { AssignCategoryDialog } from "@/features/agent-detail/components/AssignCategoryDialog";
import {
  categorySlices,
  formatShare,
  msToHuman,
  stripWww,
  summarizeAnalytics,
  totalVisits,
  type CategorySlice,
} from "@/features/agent-detail/lib/analytics";
import type { AssignTarget } from "@/features/agent-detail/lib/assignCategoryForm";
import { appColor } from "@/features/activity/appColor";
import type { DashboardRole } from "@/api/types";
import { RefreshButton } from "@/components/common/RefreshButton";

type RangeKey = AnalyticsRange;
const RANGE_OPTIONS: { id: RangeKey; text: string; label: string }[] = [
  { id: "1h", text: "1h", label: "Last hour" },
  { id: "24h", text: "24h", label: "Last 24 hours" },
  { id: "7d", text: "7d", label: "Last 7 days" },
  { id: "30d", text: "30d", label: "Last 30 days" },
];

const NO_ROWS: never[] = [];
/** Legend entries shown before "Show all"; the bar always includes every category. */
const LEGEND_PREVIEW = 5;
const OTHER_COLOR = "var(--muted-foreground)";

type SiteRows = Awaited<ReturnType<typeof api.agentAnalyticsUrlSites>>["rows"];
type AssignHandler = (
  kind: "domain" | "url",
  value: string,
  hostname: string,
  url?: string | null,
) => void;
type LastSeen = (timestamp: string | number | undefined) => string;

export function AnalyticsTab({
  agentId,
  dashboardRole = null,
}: {
  agentId: string;
  dashboardRole?: DashboardRole | null;
}) {
  const canAdmin = isAdminRole(dashboardRole);
  const [range, setRange] = useState<RangeKey>("7d");
  const [selectedCategoryKey, setSelectedCategoryKey] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<AssignTarget | null>(null);
  const data = useBrowsingAnalytics(agentId, range, selectedCategoryKey);

  const openAssign: AssignHandler = (kind, value, hostname, url) =>
    setAssignTarget({ kind, value, hostname, url: url ?? null });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle>Browsing</CardTitle>
          <div className="flex items-center gap-2">
            <RangeToggle range={range} onChange={setRange} />
            <RefreshButton onClick={data.refresh} loading={data.loading} />
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {data.failed && <LoadFailed onRetry={data.refresh} />}
          {data.nothingYet ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No browsing in this range.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
                <Metric label="Total time" value={msToHuman(data.totalMs)} />
                <Metric label="Visits" value={data.visits ? data.visits.toLocaleString() : "—"} />
                {data.loading && <Spinner className="self-center text-muted-foreground" />}
              </div>
              <CategoryShare
                slices={data.slices}
                otherMs={data.otherMs}
                totalMs={data.totalMs}
                selectedKey={selectedCategoryKey}
                onSelect={(key) =>
                  setSelectedCategoryKey((current) => (current === key ? null : key))
                }
                lastSeen={data.lastSeen}
              />
            </>
          )}
        </CardContent>
      </Card>

      <AssignCategoryDialog
        target={assignTarget}
        agentId={agentId}
        canAdmin={canAdmin}
        onClose={() => setAssignTarget(null)}
      />

      {!data.nothingYet && (
        <TopSites
          sites={data.sites}
          loading={data.loading || data.sitesLoading}
          activeCategoryLabel={data.activeCategoryLabel}
          onClearCategory={() => setSelectedCategoryKey(null)}
          canAdmin={canAdmin}
          onAssign={openAssign}
          lastSeen={data.lastSeen}
        />
      )}
    </div>
  );
}

/** Loads the three analytics feeds for the range and derives everything the tab shows from them. */
function useBrowsingAnalytics(
  agentId: string,
  range: RangeKey,
  selectedCategoryKey: string | null,
) {
  const queryClient = useQueryClient();
  // While the range or category filter changes, keep showing this agent's previous rows (never
  // another agent's) until the new window arrives.
  const keepAgentRows = <T,>(
    previous: T | undefined,
    previousQuery?: { queryKey: readonly unknown[] },
  ) => (previousQuery?.queryKey[1] === agentId ? previous : undefined);
  const categoriesQuery = useQuery({
    ...analyticsQueries.categories(agentId, range),
    placeholderData: keepAgentRows,
  });
  const sitesQuery = useQuery({
    ...analyticsQueries.sites(agentId, range, selectedCategoryKey),
    placeholderData: keepAgentRows,
  });
  // Sessions are fetched only so the total is accurate when the category rows lag or are capped.
  const sessionsQuery = useQuery({
    ...analyticsQueries.sessions(agentId, range),
    placeholderData: keepAgentRows,
  });
  const categories = categoriesQuery.data?.rows ?? NO_ROWS;
  const sites = sitesQuery.data?.rows ?? NO_ROWS;
  const sessions = sessionsQuery.data?.rows ?? NO_ROWS;
  const loading = categoriesQuery.isFetching || sessionsQuery.isFetching;
  const sitesLoading = sitesQuery.isFetching;

  // "2h ago" from when the tab opened; the exact time is on hover.
  const [openedAt] = useState(() => Date.now());
  const lastSeen: LastSeen = (ts) => {
    const date = parseTimestamp(ts);
    return date ? fmtFromNow(date, openedAt) : "—";
  };
  const { totalMs } = useMemo(
    () => summarizeAnalytics(categories, sites, sessions),
    [categories, sites, sessions],
  );
  const visits = useMemo(() => totalVisits(categories, sites), [categories, sites]);
  const { slices, otherMs } = useMemo(
    () => categorySlices(categories, totalMs),
    [categories, totalMs],
  );
  const activeCategoryLabel = selectedCategoryKey
    ? (categories.find((c) => c.category_key === selectedCategoryKey)?.category_label ??
      selectedCategoryKey)
    : null;

  return {
    sites,
    slices,
    otherMs,
    totalMs,
    visits,
    loading,
    sitesLoading,
    lastSeen,
    activeCategoryLabel,
    failed: categoriesQuery.isError || sitesQuery.isError || sessionsQuery.isError,
    nothingYet:
      !loading && !sitesLoading && totalMs === 0 && categories.length === 0 && !selectedCategoryKey,
    refresh: () => void queryClient.invalidateQueries({ queryKey: analyticsKeys.agent(agentId) }),
  };
}

function RangeToggle({
  range,
  onChange,
}: {
  range: RangeKey;
  onChange: (range: RangeKey) => void;
}) {
  return (
    <ToggleGroup
      size="sm"
      aria-label="Time range"
      value={[range]}
      onValueChange={(value) => {
        const next = value[0] as RangeKey | undefined;
        if (next) onChange(next);
      }}
    >
      {RANGE_OPTIONS.map((o) => (
        <ToggleGroupItem
          key={o.id}
          value={o.id}
          aria-label={o.label}
          title={o.label}
          className="min-w-10 max-sm:h-9"
        >
          {o.text}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-2xl font-bold tracking-tight tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <span>Couldn’t load all browsing data.</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** Where the time went: one stacked bar, and a legend whose entries filter the site list below. */
function CategoryShare({
  slices,
  otherMs,
  totalMs,
  selectedKey,
  onSelect,
  lastSeen,
}: {
  slices: CategorySlice[];
  otherMs: number;
  totalMs: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  lastSeen: LastSeen;
}) {
  const [showAll, setShowAll] = useState(false);
  if (slices.length === 0) return null;
  const legend = showAll ? slices : slices.slice(0, LEGEND_PREVIEW);
  const showOther = otherMs > 0 && otherMs / Math.max(totalMs, 1) >= 0.02;
  return (
    <div className="flex flex-col gap-3">
      <div aria-hidden className="flex h-2.5 gap-px overflow-hidden rounded-full bg-muted">
        {slices.map((slice) => (
          <div
            key={slice.key || slice.label}
            style={{
              flexGrow: slice.share,
              flexBasis: 0,
              minWidth: 3,
              background: colorFor(slice.key || slice.label),
            }}
            className={cn(
              "transition-opacity",
              selectedKey && selectedKey !== slice.key && "opacity-25",
            )}
          />
        ))}
        {showOther && (
          <div
            style={{
              flexGrow: otherMs / Math.max(totalMs, 1),
              flexBasis: 0,
              background: OTHER_COLOR,
            }}
            className="opacity-25"
          />
        )}
      </div>
      <div className="flex flex-wrap gap-x-1 gap-y-1">
        {legend.map((slice) => {
          const active = selectedKey != null && selectedKey === slice.key;
          const detail = [
            slice.visits ? `${slice.visits.toLocaleString()} visits` : null,
            slice.lastTs ? `last seen ${lastSeen(slice.lastTs)}` : null,
            slice.key ? "click to show its sites" : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <button
              key={slice.key || slice.label}
              type="button"
              disabled={!slice.key}
              aria-pressed={slice.key ? active : undefined}
              title={detail}
              onClick={() => onSelect(slice.key)}
              className={cn(
                "inline-flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[13px] transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:hover:bg-transparent",
                active && "bg-muted",
                selectedKey && !active && "opacity-60",
              )}
            >
              <span
                className="size-2.5 shrink-0 rounded-[3px]"
                style={{ background: colorFor(slice.key || slice.label) }}
                aria-hidden
              />
              <span className="font-medium">{slice.label}</span>
              <span className="tabular-nums text-xs text-muted-foreground">
                {msToHuman(slice.timeMs)} · {formatShare(slice.share)}
              </span>
            </button>
          );
        })}
        {showOther && (
          <span className="inline-flex min-h-8 items-center gap-2 px-2 text-[13px] text-muted-foreground">
            <span
              className="size-2.5 shrink-0 rounded-[3px] opacity-40"
              style={{ background: OTHER_COLOR }}
              aria-hidden
            />
            Other
            <span className="tabular-nums text-xs">{msToHuman(otherMs)}</span>
          </span>
        )}
        {slices.length > LEGEND_PREVIEW && (
          <Button
            variant="ghost"
            size="sm"
            className="self-center"
            aria-expanded={showAll}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? "Show fewer" : `+${slices.length - LEGEND_PREVIEW} more`}
          </Button>
        )}
      </div>
    </div>
  );
}

function colorFor(key: string): string {
  return key ? appColor(key) : OTHER_COLOR;
}

function TopSites({
  sites,
  loading,
  activeCategoryLabel,
  onClearCategory,
  canAdmin,
  onAssign,
  lastSeen,
}: {
  sites: SiteRows;
  loading: boolean;
  activeCategoryLabel: string | null;
  onClearCategory: () => void;
  canAdmin: boolean;
  onAssign: AssignHandler;
  lastSeen: LastSeen;
}) {
  const maxMs = sites.reduce((max, r) => Math.max(max, Number(r.time_ms) || 0), 0);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle>Top sites</CardTitle>
        {activeCategoryLabel ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={onClearCategory}
            aria-label={`Remove category filter: ${activeCategoryLabel}`}
          >
            {activeCategoryLabel}
            <X />
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="px-2">
        <Table>
          <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-10 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
            <TableRow className="hover:bg-transparent">
              <TableHead>Site</TableHead>
              <TableHead className="max-sm:hidden">Category</TableHead>
              <TableHead>Time</TableHead>
              <TableHead>Visits</TableHead>
              <TableHead className="max-sm:hidden">Last seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_td]:px-3 [&_td]:py-3">
            {loading && sites.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5}>
                  <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                    <Spinner /> Loading…
                  </div>
                </TableCell>
              </TableRow>
            ) : sites.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5}>
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No sites in this range.
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              sites.map((r) => (
                <SiteRow
                  key={r.hostname}
                  row={r}
                  maxMs={maxMs}
                  canAdmin={canAdmin}
                  onAssign={onAssign}
                  lastSeen={lastSeen}
                />
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function SiteRow({
  row,
  maxMs,
  canAdmin,
  onAssign,
  lastSeen,
}: {
  row: SiteRows[number];
  maxMs: number;
  canAdmin: boolean;
  onAssign: AssignHandler;
  lastSeen: LastSeen;
}) {
  const host = (row.hostname || "").trim();
  const name = stripWww(row.hostname || "") || "—";
  const timeMs = Number(row.time_ms) || 0;
  const label = row.category_label || row.category_key || "—";
  const category =
    host && canAdmin ? (
      <Button
        variant="link"
        size="sm"
        className="h-auto p-0 text-muted-foreground hover:text-foreground"
        title="Assign a category to this site"
        onClick={() => onAssign("domain", host, host, null)}
      >
        {label}
      </Button>
    ) : (
      label
    );
  return (
    <TableRow>
      <TableCell className="w-full max-w-0">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span title={name} className="truncate font-mono text-xs">
            {name}
          </span>
          <div aria-hidden className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${maxMs > 0 ? Math.max((timeMs / maxMs) * 100, 2) : 0}%`,
                background: colorFor(row.category_key || ""),
              }}
            />
          </div>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground sm:hidden">
            {category}
            <span aria-hidden>·</span>
            <span title={fmtDateTime(row.last_ts)}>{lastSeen(row.last_ts)}</span>
          </span>
        </div>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground max-sm:hidden">{category}</TableCell>
      <TableCell className="whitespace-nowrap tabular-nums">{msToHuman(timeMs)}</TableCell>
      <TableCell className="tabular-nums">{String(row.visit_count ?? 0)}</TableCell>
      <TableCell
        className="whitespace-nowrap text-xs text-muted-foreground max-sm:hidden"
        title={fmtDateTime(row.last_ts)}
      >
        {lastSeen(row.last_ts)}
      </TableCell>
    </TableRow>
  );
}
