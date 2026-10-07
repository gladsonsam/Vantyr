import { RefreshCw } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@vantyr/ui/components/card";
import { Spinner } from "@vantyr/ui/components/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@vantyr/ui/components/table";
import { ToggleGroup, ToggleGroupItem } from "@vantyr/ui/components/toggle-group";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { analyticsKeys, analyticsQueries, type AnalyticsRange } from "@/api/queries/analytics";
import { fmtDateTime } from "@/lib/utils";
import { isAdminRole } from "@/features/auth/permissions";
import { AssignCategoryDialog } from "@/features/agent-detail/components/AssignCategoryDialog";
import { categoryChartBars, labelToCategoryKey, msToHuman, stripWww, summarizeAnalytics } from "@/features/agent-detail/lib/analytics";
import type { AssignTarget } from "@/features/agent-detail/lib/assignCategoryForm";
import type { DashboardRole } from "@/api/types";

type RangeKey = AnalyticsRange;
const RANGE_OPTIONS: { id: RangeKey; text: string }[] = [
  { id: "1h", text: "1h" },
  { id: "24h", text: "24h" },
  { id: "7d", text: "7d" },
  { id: "30d", text: "30d" },
];

const NO_ROWS: never[] = [];

export function AnalyticsTab({ agentId, dashboardRole = null }: { agentId: string; dashboardRole?: DashboardRole | null }) {
  const canAdmin = isAdminRole(dashboardRole);
  const queryClient = useQueryClient();
  const [range, setRange] = useState<RangeKey>("7d");
  const [selectedCategoryKey, setSelectedCategoryKey] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<AssignTarget | null>(null);

  // While the range or category filter changes, keep showing this agent's previous rows (never
  // another agent's) until the new window arrives.
  const keepAgentRows = <T,>(previous: T | undefined, previousQuery?: { queryKey: readonly unknown[] }) =>
    previousQuery?.queryKey[1] === agentId ? previous : undefined;
  const categoriesQuery = useQuery({ ...analyticsQueries.categories(agentId, range), placeholderData: keepAgentRows });
  const sitesQuery = useQuery({ ...analyticsQueries.sites(agentId, range, selectedCategoryKey), placeholderData: keepAgentRows });
  const sessionsQuery = useQuery({ ...analyticsQueries.sessions(agentId, range), placeholderData: keepAgentRows });
  const categories = categoriesQuery.data?.rows ?? NO_ROWS;
  const sites = sitesQuery.data?.rows ?? NO_ROWS;
  const sessions = sessionsQuery.data?.rows ?? NO_ROWS;
  const loading = categoriesQuery.isFetching || sessionsQuery.isFetching;
  const sitesLoading = sitesQuery.isFetching;
  const refresh = () => void queryClient.invalidateQueries({ queryKey: analyticsKeys.agent(agentId) });

  const labelToKey = useMemo(() => labelToCategoryKey(categories), [categories]);
  const { totalMs, sessionCount, topSite, topCategory } = useMemo(
    () => summarizeAnalytics(categories, sites, sessions),
    [categories, sites, sessions],
  );
  const { bars: chartBars, max: chartMax } = useMemo(() => categoryChartBars(categories), [categories]);

  const activeFilterLabel = selectedCategoryKey
    ? (categories.find((c) => c.category_key === selectedCategoryKey)?.category_label ?? selectedCategoryKey)
    : null;

  const openAssign = (kind: "domain" | "url", value: string, hostname: string, url?: string | null) =>
    setAssignTarget({ kind, value, hostname, url: url ?? null });

  // sessions are still fetched to compute total time accurately.

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle>Browsing time</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <ToggleGroup
              size="sm"
              aria-label="Range"
              value={[range]}
              onValueChange={(value) => {
                const next = value[0] as RangeKey | undefined;
                if (next) setRange(next);
              }}
            >
              {RANGE_OPTIONS.map((o) => (
                <ToggleGroupItem key={o.id} value={o.id} aria-label={`${o.text} range`}>
                  {o.text}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Button variant="outline" size="sm" disabled={loading} onClick={refresh}>
              {loading ? <Spinner /> : <RefreshCw />} Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4 pb-2 sm:grid-cols-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">Total time</span>
              <span className="text-lg font-bold tracking-tight">{msToHuman(totalMs)}</span>
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">Sessions</span>
              <span className="text-lg font-bold tracking-tight">{sessionCount || "—"}</span>
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">Top site</span>
              {topSite ? (
                <>
                  <span title={topSite.hostname} className="truncate text-lg font-bold tracking-tight">
                    {topSite.hostname}
                  </span>
                  <span className="text-xs text-muted-foreground">{msToHuman(topSite.timeMs)}</span>
                </>
              ) : <span className="text-lg font-bold tracking-tight">—</span>}
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">Top category</span>
              {topCategory ? (
                <>
                  <span title={topCategory.label} className="truncate text-lg font-bold tracking-tight">
                    {topCategory.label}
                  </span>
                  <span className="text-xs text-muted-foreground">{msToHuman(topCategory.timeMs)}</span>
                </>
              ) : <span className="text-lg font-bold tracking-tight">—</span>}
            </div>
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : chartBars.length === 0 ? (
            <p className="text-sm text-muted-foreground">No browsing in this range.</p>
          ) : (
            <div role="img" aria-label="Time spent by category" className="flex h-[260px] items-stretch gap-2 border-b border-foreground/[0.06] pb-1">
              {chartBars.map((item) => {
                const pct = Math.max(2, (item.y / chartMax) * 100);
                const formatted = msToHuman(item.y);
                const key = labelToKey.get(item.x.trim()) ?? null;
                return (
                  <button
                    key={item.x}
                    type="button"
                    title={`${item.x}: ${formatted} — show sites`}
                    aria-label={`${item.x}: ${formatted}. Show sites.`}
                    disabled={!key}
                    onClick={() => {
                      if (!key) return;
                      setSelectedCategoryKey(key);
                    }}
                    className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1.5 rounded-md hover:bg-muted/50 disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <span className="text-[11px] text-muted-foreground tabular-nums">{formatted}</span>
                    <span className="w-full max-w-10 rounded-t bg-primary" style={{ height: `${pct}%` }} aria-hidden="true" />
                    <span className="w-full truncate text-center text-[10px] text-muted-foreground">
                      {item.x}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <AssignCategoryDialog target={assignTarget} agentId={agentId} canAdmin={canAdmin} onClose={() => setAssignTarget(null)} />

      <Card>
        <CardHeader>
          <CardTitle>Top categories</CardTitle>
        </CardHeader>
        <CardContent className="px-2">
          <Table>
            <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
              <TableRow className="hover:bg-transparent">
                <TableHead>Category</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Visits</TableHead>
                <TableHead>Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_td]:px-3 [&_td]:py-3.5">
              {loading && categories.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={4}>
                    <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                      <Spinner /> Loading…
                    </div>
                  </TableCell>
                </TableRow>
              ) : categories.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={4}>
                    <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                      No browsing in this range.
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                categories.map((r, i) => {
                  const label = r.category_label || r.category_key || "—";
                  const key = (r.category_key || "").trim();
                  return (
                    <TableRow key={`${r.category_key}-${i}`}>
                      <TableCell>
                        {key ? (
                          <Button
                            variant="link"
                            size="sm"
                            className="h-auto p-0"
                            title={`Show sites for ${label}`}
                            onClick={() => setSelectedCategoryKey(key)}
                          >
                            {label}
                          </Button>
                        ) : label}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">{msToHuman(Number(r.time_ms) || 0)}</TableCell>
                      <TableCell className="tabular-nums">{String(r.visit_count ?? 0)}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{fmtDateTime(r.last_ts)}</TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle>Top sites</CardTitle>
          {activeFilterLabel ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Filtered by: {activeFilterLabel}</span>
              <Button variant="outline" size="sm" onClick={() => setSelectedCategoryKey(null)}>Show all</Button>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="px-2">
          <Table>
            <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
              <TableRow className="hover:bg-transparent">
                <TableHead>Hostname</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Visits</TableHead>
                <TableHead>Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_td]:px-3 [&_td]:py-3.5">
              {(loading || sitesLoading) && sites.length === 0 ? (
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
                sites.map((r, i) => {
                  const label = r.category_label || r.category_key || "—";
                  const host = (r.hostname || "").trim();
                  return (
                    <TableRow key={`${r.hostname}-${i}`}>
                      <TableCell className="font-mono text-xs">{stripWww(r.hostname || "") || "—"}</TableCell>
                      <TableCell>
                        {host && canAdmin ? (
                          <Button
                            variant="link"
                            size="sm"
                            className="h-auto p-0"
                            onClick={() => openAssign("domain", host, host, null)}
                          >
                            {label}
                          </Button>
                        ) : label}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">{msToHuman(Number(r.time_ms) || 0)}</TableCell>
                      <TableCell className="tabular-nums">{String(r.visit_count ?? 0)}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{fmtDateTime(r.last_ts)}</TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
