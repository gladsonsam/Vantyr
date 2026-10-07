import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { analyticsKeys, analyticsQueries, type AnalyticsRange } from "@/api/queries/analytics";
import { urlCategoryQueries } from "@/api/queries/urlCategories";
import { fmtDateTime } from "@/lib/utils";
import { isAdminRole } from "@/features/auth/permissions";
import type { DashboardRole } from "@/api/types";

type RangeKey = AnalyticsRange;
const RANGE_OPTIONS: { id: RangeKey; text: string }[] = [
  { id: "1h", text: "1h" },
  { id: "24h", text: "24h" },
  { id: "7d", text: "7d" },
  { id: "30d", text: "30d" },
];

function humanizeCategoryKey(key: string): string {
  const raw = (key || "").trim();
  if (!raw) return "—";
  // Title Case words; split on underscores/dashes.
  return raw
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function msToHuman(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}

type CategoryOption = { value: string; label: string };
type CustomGroup = { id: number; key: string; label: string; hidden: boolean; ut1_keys: string[] };
const NO_ROWS: never[] = [];
const NO_OPTIONS: CategoryOption[] = [];
const NO_GROUPS: CustomGroup[] = [];

function toCategoryOptions(res: { categories: { key: string; label?: string; enabled: boolean }[] }): CategoryOption[] {
  return (res.categories ?? [])
    .filter((c) => c.enabled)
    .map((c) => ({ value: c.key, label: c.label?.trim() ? (c.label as string) : humanizeCategoryKey(c.key) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function toCustomGroups(res: { rows: { id: number; key: string; label_en: string; hidden: boolean; ut1_keys: string[] }[] }): CustomGroup[] {
  return (res.rows ?? [])
    .filter((r) => !r.hidden)
    .map((r) => ({
      id: r.id,
      key: r.key,
      label: r.label_en,
      hidden: r.hidden,
      ut1_keys: Array.isArray(r.ut1_keys) ? r.ut1_keys : [],
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function stripWww(hostname: string): string {
  const h = (hostname || "").trim();
  if (!h) return "";
  return h.toLowerCase().startsWith("www.") ? h.slice(4) : h;
}

export function AnalyticsTab({ agentId, dashboardRole = null }: { agentId: string; dashboardRole?: DashboardRole | null }) {
  const canAdmin = isAdminRole(dashboardRole);
  const queryClient = useQueryClient();
  const [range, setRange] = useState<RangeKey>("7d");
  const [selectedCategoryKey, setSelectedCategoryKey] = useState<string | null>(null);
  const [assignOpen, setAssignOpen] = useState<null | { kind: "domain" | "url"; value: string; hostname: string; url?: string | null }>(null);
  const [assignCategoryKey, setAssignCategoryKey] = useState<string | null>(null);
  const [assignCustomKey, setAssignCustomKey] = useState<string | null>(null);
  const [assignSpecific, setAssignSpecific] = useState(false);
  const [assignNote, setAssignNote] = useState<string>("");

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

  // Category list for quick assignment UX (best-effort; assigning still works without it).
  const categoryOptionsQuery = useQuery({ ...urlCategoryQueries.categories(), select: toCategoryOptions });
  const categoryOptions = categoryOptionsQuery.data ?? NO_OPTIONS;

  // Custom groups are only needed once the assign dialog has been opened; fetched once, then
  // refreshed only when categories change.
  const [customGroupsWanted, setCustomGroupsWanted] = useState(false);
  const customGroupsQuery = useQuery({
    ...urlCategoryQueries.customCategories(),
    enabled: customGroupsWanted,
    staleTime: Infinity,
    select: toCustomGroups,
  });
  const customGroups = customGroupsQuery.data ?? NO_GROUPS;

  const labelToKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of categories) {
      const label = (r.category_label || "").trim();
      const key = (r.category_key || "").trim();
      if (label && key) m.set(label, key);
    }
    return m;
  }, [categories]);

  const totalMs = useMemo(
    () => sessions.reduce((acc, r) => acc + (Number(r.duration_ms) || 0), 0),
    [sessions]
  );

  const sessionCount = useMemo(
    () => sites.reduce((acc, r) => acc + (Number(r.visit_count) || 0), 0),
    [sites]
  );

  const topSite = useMemo(() => {
    const r = sites?.[0];
    if (!r || !(r.hostname || "").trim()) return null;
    return { hostname: stripWww(r.hostname), timeMs: Number(r.time_ms) || 0 };
  }, [sites]);

  const topCategory = useMemo(() => {
    const r = categories?.[0];
    const label = (r?.category_label || r?.category_key || "").trim();
    if (!label) return null;
    return { label, timeMs: Number(r.time_ms) || 0 };
  }, [categories]);

  const chartBars = useMemo(() => {
    return categories
      .filter((r) => (r.category_label || "").trim() !== "")
      .slice(0, 8)
      .map((r) => ({ x: r.category_label, y: Number(r.time_ms) || 0 }));
  }, [categories]);
  const chartMax = chartBars.reduce((mx, r) => Math.max(mx, r.y), 1);

  const activeFilterLabel = selectedCategoryKey
    ? (categories.find((c) => c.category_key === selectedCategoryKey)?.category_label ?? selectedCategoryKey)
    : null;

  const openAssign = (kind: "domain" | "url", value: string, hostname: string, url?: string | null) => {
    setAssignOpen({ kind, value, hostname, url: url ?? null });
    setAssignCategoryKey(null);
    setAssignCustomKey(null);
    setAssignSpecific(false);
    setAssignNote("");
    if (categoryOptions.length === 0) {
      void categoryOptionsQuery.refetch();
    }
    setCustomGroupsWanted(true);
  };

  const assign = useMutation({
    mutationFn: (body: { kind: "domain" | "url"; value: string; category_key: string; note?: string }) =>
      api.urlCategorizationOverridesUpsert(body),
    onSuccess: async () => {
      // Apply to recent sessions so the UI updates immediately.
      void api.urlCategorizationRecalcUrlSessions({ limit: 50_000 }).catch(() => {});
      setAssignOpen(null);
      await queryClient.invalidateQueries({ queryKey: analyticsKeys.agent(agentId) });
    },
  });
  const assignSaving = assign.isPending;

  const saveAssign = () => {
    // Backend: overrides upsert + recalc are admin-only.
    if (!canAdmin) return;
    if (!assignOpen || !assignCategoryKey) return;
    assign.mutate({
      kind: assignOpen.kind,
      value: assignOpen.value,
      category_key: assignCategoryKey,
      note: assignNote?.trim() ? assignNote.trim() : undefined,
    });
  };

  const customOptions = useMemo(
    () => customGroups.map((g) => ({ value: g.key, label: g.label })),
    [customGroups]
  );

  const ut1OptionsForSelectedCustom = useMemo(() => {
    if (!assignCustomKey) return categoryOptions;
    const g = customGroups.find((x) => x.key === assignCustomKey);
    if (!g) return categoryOptions;
    const allowed = new Set((g.ut1_keys ?? []).map((k) => String(k)));
    return categoryOptions.filter((o) => allowed.has(o.value));
  }, [assignCustomKey, customGroups, categoryOptions]);

  const pickCustomCategory = (customKey: string | null) => {
    setAssignCustomKey(customKey);
    if (!customKey) {
      // fall back to UT1-only mode
      setAssignCategoryKey(null);
      return;
    }
    const g = customGroups.find((x) => x.key === customKey);
    const firstUt1 = g?.ut1_keys?.[0] ?? null;
    // Set an underlying UT1 key so the override works with existing storage.
    setAssignCategoryKey(firstUt1);
  };

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

      <Dialog open={assignOpen !== null} onOpenChange={(open) => { if (!open) setAssignOpen(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign category</DialogTitle>
          </DialogHeader>
          {assignOpen ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-0.5 text-sm">
                <span className="text-muted-foreground">Override type</span>
                <span>{assignOpen.kind === "domain" ? "Domain" : "URL prefix"}</span>
              </div>
              <div className="flex flex-col gap-0.5 text-sm">
                <span className="text-muted-foreground">Match value</span>
                <span className="font-mono text-[13px] wrap-break-word">{assignOpen.value}</span>
              </div>
              <Field>
                <FieldLabel htmlFor="assign-custom">Category</FieldLabel>
                <Select
                  value={assignCustomKey ?? ""}
                  onValueChange={(v) => pickCustomCategory(v || null)}
                >
                  <SelectTrigger id="assign-custom" className="w-full">
                    <SelectValue placeholder="Select a custom category" />
                  </SelectTrigger>
                  <SelectContent>
                    {customOptions.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <label className="flex cursor-pointer items-center gap-2 pt-1 text-sm">
                  <Checkbox
                    checked={assignSpecific}
                    onCheckedChange={(checked) => setAssignSpecific(checked === true)}
                  />
                  More specific
                </label>
                {assignSpecific ? (
                  <Select
                    value={assignCategoryKey ?? ""}
                    disabled={!assignCustomKey}
                    onValueChange={(v) => setAssignCategoryKey(v || null)}
                  >
                    <SelectTrigger aria-label="UT1 category" className="w-full">
                      <SelectValue placeholder="Select a UT1 category" />
                    </SelectTrigger>
                    <SelectContent>
                      {ut1OptionsForSelectedCustom.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                {!assignCustomKey ? (
                  <p className="text-[13px] text-muted-foreground">
                    No custom categories. Add one in Settings.
                  </p>
                ) : null}
              </Field>
              <Field>
                <FieldLabel htmlFor="assign-note">Note (optional)</FieldLabel>
                <Textarea id="assign-note" value={assignNote} onChange={(e) => setAssignNote(e.target.value)} rows={2} />
              </Field>
              {assignOpen.kind === "domain" && assignOpen.url ? (
                <p className="text-[13px] text-muted-foreground">
                  Use a URL prefix to match one path.
                </p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(null)} disabled={assignSaving}>
              Cancel
            </Button>
            <Button onClick={saveAssign} disabled={assignSaving || !assignCategoryKey}>
              {assignSaving && <Spinner />} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
