import { Box, Button, Container, Header, Link, Modal, FormField, Select, Textarea, Toggle, SegmentedControl, SpaceBetween, Table, BarChart } from "../ui/console";
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { api } from "../../lib/api";
import { fmtDateTime } from "../../lib/utils";

type RangeKey = "1h" | "24h" | "7d" | "30d";
const RANGE_OPTIONS = [
  { id: "1h", text: "1h" },
  { id: "24h", text: "24h" },
  { id: "7d", text: "7d" },
  { id: "30d", text: "30d" },
] as const;

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

/** Formatter for chart Y-axis ticks — avoids repeated labels at coarse granularity. */
function msToChartTick(ms: number, maxMs: number): string {
  if (ms === 0) return "0";
  const s = Math.floor(ms / 1000);
  // Use seconds when the whole range fits under 5 minutes (avoids "1m 1m 1m")
  if (maxMs < 5 * 60 * 1000) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function rangeToFromTo(key: RangeKey): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime());
  if (key === "1h") from.setHours(from.getHours() - 1);
  else if (key === "24h") from.setDate(from.getDate() - 1);
  else if (key === "7d") from.setDate(from.getDate() - 7);
  else from.setDate(from.getDate() - 30);
  return { from: from.toISOString(), to: to.toISOString() };
}

function stripWww(hostname: string): string {
  const h = (hostname || "").trim();
  if (!h) return "";
  return h.toLowerCase().startsWith("www.") ? h.slice(4) : h;
}

export function AnalyticsTab({ agentId }: { agentId: string }) {
  const [range, setRange] = useState<RangeKey>("7d");
  const [loading, setLoading] = useState(false);
  const [sitesLoading, setSitesLoading] = useState(false);
  const [selectedCategoryKey, setSelectedCategoryKey] = useState<string | null>(null);
  const [categoryOptions, setCategoryOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [assignOpen, setAssignOpen] = useState<null | { kind: "domain" | "url"; value: string; hostname: string; url?: string | null }>(null);
  const [assignSaving, setAssignSaving] = useState(false);
  const [assignCategoryKey, setAssignCategoryKey] = useState<string | null>(null);
  const [assignCustomKey, setAssignCustomKey] = useState<string | null>(null);
  const [assignSpecific, setAssignSpecific] = useState(false);
  const [assignNote, setAssignNote] = useState<string>("");
  const [categories, setCategories] = useState<
    { category_key: string; category_label: string; time_ms: number; visit_count: number; last_ts: string }[]
  >([]);
  const [sites, setSites] = useState<
    { hostname: string; category_key: string | null; category_label: string | null; time_ms: number; visit_count: number; last_ts: string }[]
  >([]);
  const [sessions, setSessions] = useState<
    { id: number; url: string; hostname: string; ts_start: string; ts_end: string; duration_ms: number; category_label?: string | null }[]
  >([]);

  const loadCategoryOptions = useCallback(async () => {
    try {
      const res = await api.urlCategorizationCategoriesGet();
      const opts = (res.categories ?? [])
        .filter((c) => c.enabled)
        .map((c) => ({ value: c.key, label: c.label?.trim() ? (c.label as string) : humanizeCategoryKey(c.key) }))
        .sort((a, b) => a.label.localeCompare(b.label));
      setCategoryOptions(opts);
    } catch {
      // best-effort; assigning will still work but options may be empty
    }
  }, []);

  const [customGroups, setCustomGroups] = useState<
    { id: number; key: string; label: string; hidden: boolean; ut1_keys: string[] }[]
  >([]);

  const loadCustomGroups = useCallback(async () => {
    try {
      const res = await api.urlCustomCategoriesList();
      const rows = (res.rows ?? [])
        .filter((r) => !r.hidden)
        .map((r) => ({
          id: r.id,
          key: r.key,
          label: r.label_en,
          hidden: r.hidden,
          ut1_keys: Array.isArray(r.ut1_keys) ? r.ut1_keys : [],
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
      setCustomGroups(rows);
    } catch {
      setCustomGroups([]);
    }
  }, []);

  const labelToKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of categories) {
      const label = (r.category_label || "").trim();
      const key = (r.category_key || "").trim();
      if (label && key) m.set(label, key);
    }
    return m;
  }, [categories]);

  const loadSites = useCallback(async (catKey: string | null) => {
    const { from, to } = rangeToFromTo(range);
    setSitesLoading(true);
    try {
      const s = await api.agentAnalyticsUrlSites(agentId, { from, to, limit: 25, custom_category_key: catKey ?? undefined });
      setSites(s.rows ?? []);
    } finally {
      setSitesLoading(false);
    }
  }, [agentId, range]);

  const load = useCallback(async () => {
    const { from, to } = rangeToFromTo(range);
    setLoading(true);
    try {
      // Load category list for quick assignment UX.
      if (categoryOptions.length === 0) {
        void loadCategoryOptions();
      }
      const [cats, s, sess] = await Promise.all([
        api.agentAnalyticsUrlCategories(agentId, { from, to, limit: 25 }),
        api.agentAnalyticsUrlSites(agentId, { from, to, limit: 25, custom_category_key: selectedCategoryKey ?? undefined }),
        api.agentAnalyticsUrlSessions(agentId, { from, to, limit: 200 }),
      ]);
      setCategories(cats.rows ?? []);
      setSites(s.rows ?? []);
      setSessions(sess.rows ?? []);
    } finally {
      setLoading(false);
    }
  }, [agentId, categoryOptions.length, loadCategoryOptions, range, selectedCategoryKey]);

  useEffect(() => {
    void load();
    // If the user changes range or agent, keep the current category filter but refetch sites too.
  }, [load]);

  useEffect(() => {
    const onChanged = () => {
      // Categories/groups changed in Settings; refresh current view.
      void load();
      // Also refresh pickers used by Assign category.
      void loadCategoryOptions();
      void loadCustomGroups();
    };
    window.addEventListener("vantyr.urlCategoriesChanged", onChanged as EventListener);
    return () => window.removeEventListener("vantyr.urlCategoriesChanged", onChanged as EventListener);
  }, [load, loadCategoryOptions, loadCustomGroups]);

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

  const chartSeries = useMemo(() => {
    const top = categories
      .filter((r) => (r.category_label || "").trim() !== "")
      .slice(0, 8)
      .map((r) => ({ x: r.category_label, y: Number(r.time_ms) || 0 }));
    const maxMs = top.reduce((mx, r) => Math.max(mx, r.y), 0);
    return {
      series: [
        {
          title: "Time spent",
          type: "bar",
          data: top,
          valueFormatter: (v: number) => msToHuman(Number(v) || 0),
        },
      ] as unknown as Array<{
        title: string;
        type: "bar";
        data: Array<{ x: string; y: number }>;
        valueFormatter?: (value: number) => string;
      }>,
      maxMs,
    };
  }, [categories]);

  const sitesHeader = useMemo(() => {
    const active = selectedCategoryKey ? (categories.find((c) => c.category_key === selectedCategoryKey)?.category_label ?? selectedCategoryKey) : null;
    return (
      <Header
        variant="h2"
        actions={
          active ? (
            <SpaceBetween direction="horizontal" size="xs">
              <Box color="text-body-secondary" padding={{ top: "xxs" }}>
                Filtered by: {active}
              </Box>
              <Button onClick={() => setSelectedCategoryKey(null)}>Show all</Button>
            </SpaceBetween>
          ) : null
        }
      >
        Top sites
      </Header>
    );
  }, [selectedCategoryKey, categories]);

  const openAssign = (kind: "domain" | "url", value: string, hostname: string, url?: string | null) => {
    setAssignOpen({ kind, value, hostname, url: url ?? null });
    setAssignCategoryKey(null);
    setAssignCustomKey(null);
    setAssignSpecific(false);
    setAssignNote("");
    if (categoryOptions.length === 0) {
      void loadCategoryOptions();
    }
    if (customGroups.length === 0) {
      void loadCustomGroups();
    }
  };

  const saveAssign = async () => {
    if (!assignOpen || !assignCategoryKey) return;
    setAssignSaving(true);
    try {
      await api.urlCategorizationOverridesUpsert({
        kind: assignOpen.kind,
        value: assignOpen.value,
        category_key: assignCategoryKey,
        note: assignNote?.trim() ? assignNote.trim() : undefined,
      });
      // Apply to recent sessions so the UI updates immediately.
      void api.urlCategorizationRecalcUrlSessions({ limit: 50_000 }).catch(() => {});
      setAssignOpen(null);
      await load();
    } finally {
      setAssignSaving(false);
    }
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
    <SpaceBetween size="l">
      <Container
        header={
          <Header
            variant="h2"
            description="Time spent is based on agent-reported URL sessions (foreground browsing)."
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <SegmentedControl
                  label="Range"
                  selectedId={range}
                  options={RANGE_OPTIONS as unknown as { id: string; text: string }[]}
                  onChange={({ detail }) => setRange(detail.selectedId as RangeKey)}
                />
                <Button iconName="refresh" onClick={() => void load()} loading={loading}>
                  Refresh
                </Button>
              </SpaceBetween>
            }
          >
            Analytics
          </Header>
        }
      >
        <SpaceBetween size="m">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
              gap: "16px",
              paddingBottom: "8px",
            }}
          >
            <Box>
              <Box>Total browsing time</Box>
              <Box fontSize="heading-m">{msToHuman(totalMs)}</Box>
            </Box>
            <Box>
              <Box>Sessions</Box>
              <Box fontSize="heading-m">{sessionCount || "—"}</Box>
            </Box>
            <Box>
              <Box>Top site (time)</Box>
              {topSite ? (
                <>
                  <div
                    title={topSite.hostname}
                    style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 700, fontSize: "1.1rem" }}
                  >
                    {topSite.hostname}
                  </div>
                  <Box color="text-body-secondary" fontSize="body-s">{msToHuman(topSite.timeMs)}</Box>
                </>
              ) : <Box fontSize="heading-m">—</Box>}
            </Box>
            <Box>
              <Box>Top category (time)</Box>
              {topCategory ? (
                <>
                  <div
                    title={topCategory.label}
                    style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 700, fontSize: "1.1rem" }}
                  >
                    {topCategory.label}
                  </div>
                  <Box color="text-body-secondary" fontSize="body-s">{msToHuman(topCategory.timeMs)}</Box>
                </>
              ) : <Box fontSize="heading-m">—</Box>}
            </Box>
          </div>

          {loading ? (
            <Box color="text-body-secondary">Loading chart…</Box>
          ) : (
            <BarChart
              series={chartSeries.series}
              height={260}
              xTitle="Category"
              yTitle="Time"
              hideFilter
              hideLegend
              detailPopoverFooter={(x: unknown) => {
                const label = String(x ?? "").trim();
                const key = labelToKey.get(label) ?? null;
                const canFilter = Boolean(key);
                return (
                  <SpaceBetween direction="horizontal" size="xs">
                    <Box color="text-body-secondary">{label || "—"}</Box>
                    <Button
                      disabled={!canFilter}
                      onClick={() => {
                        setSelectedCategoryKey(key);
                        void loadSites(key);
                      }}
                    >
                      Show sites
                    </Button>
                  </SpaceBetween>
                );
              }}
              yTickFormatter={(v: unknown) => msToChartTick(Number(v) || 0, chartSeries.maxMs)}
              i18nStrings={{
                xTickFormatter: (s: unknown) => String(s),
                yTickFormatter: (v: unknown) => msToChartTick(Number(v) || 0, chartSeries.maxMs),
                filterLabel: "Filter",
                filterPlaceholder: "Filter",
                filterSelectedAriaLabel: "selected",
                detailPopoverDismissAriaLabel: "Dismiss",
                legendAriaLabel: "Legend",
                chartAriaRoleDescription: "bar chart",
              }}
            />
          )}
        </SpaceBetween>
      </Container>

      <Modal
        visible={Boolean(assignOpen)}
        onDismiss={() => setAssignOpen(null)}
        header="Assign category"
        footer={
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => setAssignOpen(null)} disabled={assignSaving}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void saveAssign()} loading={assignSaving} disabled={!assignCategoryKey}>
              Save
            </Button>
          </SpaceBetween>
        }
      >
        {assignOpen ? (
          <SpaceBetween size="m">
            <Box>
              <Box>Override type</Box>
              <Box>{assignOpen.kind === "domain" ? "Domain" : "URL prefix"}</Box>
            </Box>
            <Box>
              <Box>Match value</Box>
              <Box>{assignOpen.value}</Box>
            </Box>
            <FormField label="Category">
              <SpaceBetween size="xs">
                <Select
                  selectedOption={
                    assignCustomKey
                      ? { value: assignCustomKey, label: customOptions.find((o) => o.value === assignCustomKey)?.label ?? assignCustomKey }
                      : null
                  }
                  onChange={({ detail }) => pickCustomCategory((detail.selectedOption?.value as string) ?? null)}
                  options={customOptions}
                  placeholder="Select a custom category"
                />
                <Toggle
                  checked={assignSpecific}
                  onChange={({ detail }) => setAssignSpecific(detail.checked)}
                  description="Pick a specific UT1 category if needed."
                >
                  More specific
                </Toggle>
                {assignSpecific ? (
                  <Select
                    selectedOption={
                      assignCategoryKey
                        ? {
                            value: assignCategoryKey,
                            label:
                              ut1OptionsForSelectedCustom.find((o) => o.value === assignCategoryKey)?.label ??
                              categoryOptions.find((o) => o.value === assignCategoryKey)?.label ??
                              assignCategoryKey,
                          }
                        : null
                    }
                    onChange={({ detail }) => setAssignCategoryKey((detail.selectedOption?.value as string) ?? null)}
                    options={ut1OptionsForSelectedCustom.map((o) => ({ value: o.value, label: o.label }))}
                    placeholder="Select a UT1 category"
                    disabled={!assignCustomKey}
                  />
                ) : null}
                {!assignCustomKey ? (
                  <Box color="text-body-secondary" fontSize="body-s">
                    No custom categories yet — create one in Settings → URL categorization → Custom categories.
                  </Box>
                ) : null}
              </SpaceBetween>
            </FormField>
            <FormField label="Note (optional)" description="Helps explain why this override exists.">
              <Textarea value={assignNote} onChange={({ detail }) => setAssignNote(detail.value)} rows={2} />
            </FormField>
            {assignOpen.kind === "domain" && assignOpen.url ? (
              <Box color="text-body-secondary">
                Tip: pick “URL prefix” if you only want to categorize a specific path on this site.
              </Box>
            ) : null}
          </SpaceBetween>
        ) : null}
      </Modal>

      <Container header={<Header variant="h2">Top categories</Header>}>
        <Table
          items={categories}
          loading={loading}
          columnDefinitions={[
            {
              id: "category",
              header: "Category",
              cell: (r) => {
                const label = r.category_label || r.category_key || "—";
                const key = (r.category_key || "").trim();
                if (!key) return label;
                return (
                  <Link
                    href="#"
                    onFollow={(e: MouseEvent<HTMLAnchorElement>) => {
                      e.preventDefault();
                      setSelectedCategoryKey(key);
                      void loadSites(key);
                    }}
                  >
                    {label}
                  </Link>
                );
              },
            },
            { id: "time", header: "Time", cell: (r) => msToHuman(Number(r.time_ms) || 0) },
            { id: "visits", header: "Visits", cell: (r) => String(r.visit_count ?? 0) },
            { id: "last", header: "Last seen", cell: (r) => fmtDateTime(r.last_ts) },
          ]}
          variant="container"
          stickyHeader
          empty={<Box color="text-body-secondary">No browsing sessions in this range yet.</Box>}
        />
      </Container>

      <Container header={sitesHeader}>
        <Table
          items={sites}
          loading={loading || sitesLoading}
          columnDefinitions={[
            { id: "host", header: "Hostname", cell: (r) => stripWww(r.hostname || "") || "—" },
            {
              id: "cat",
              header: "Category",
              cell: (r) => {
                const label = r.category_label || r.category_key || "—";
                const host = (r.hostname || "").trim();
                if (!host) return label;
                return (
                  <Link
                    href="#"
                    onFollow={(e: MouseEvent<HTMLAnchorElement>) => {
                      e.preventDefault();
                      openAssign("domain", host, host, null);
                    }}
                  >
                    {label}
                  </Link>
                );
              },
            },
            { id: "time", header: "Time", cell: (r) => msToHuman(Number(r.time_ms) || 0) },
            { id: "visits", header: "Visits", cell: (r) => String(r.visit_count ?? 0) },
            { id: "last", header: "Last seen", cell: (r) => fmtDateTime(r.last_ts) },
          ]}
          variant="container"
          stickyHeader
          empty={<Box color="text-body-secondary">No sites in this range yet.</Box>}
        />
      </Container>

    </SpaceBetween>
  );
}
