import { ChevronDown, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataTable } from "@/components/common/data-table/DataTable";
import { DataTableColumnHeader } from "@/components/common/data-table/DataTableColumnHeader";
import { DataTablePagination } from "@/components/common/data-table/DataTablePagination";
import { createDataTableColumns } from "@/components/common/data-table/features";
import { useDataTable } from "@/components/common/data-table/useDataTable";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import type { AppBlockEvent, AlertRuleRow, AppBlockRule } from "../../lib/types";
import { AppIcon } from "../common/AppIcon";
import { fmtDateTime } from "../../lib/utils";
import { alertChannelLabel } from "../../lib/alertChannels";
import { cn } from "@/lib/utils";
import { ScreenshotDialog } from "@/components/common/ScreenshotDialog";

// ── Shared bits ───────────────────────────────────────────────────────────────

/** Channel word in its hue — no chip, just coloured text. */
function ChannelWord({ channel }: { channel: string }) {
  const tone =
    channel === "url" ? "text-info"
    : channel === "agent_offline" ? "text-destructive"
    : channel === "resource" ? "text-warning"
    : channel === "url_category" ? "text-primary"
    : "text-muted-foreground";
  return <span className={tone}>{alertChannelLabel(channel)}</span>;
}

function ScopeWord({ kind }: { kind?: string }) {
  if (kind === "all") return <span className="text-destructive">All devices</span>;
  if (kind === "group") return <span className="text-warning">Group</span>;
  return <span className="text-muted-foreground">This device</span>;
}

function StatusWord({ blocked }: { blocked: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 text-[13px]">
      <span className={cn("size-[7px] rounded-full", blocked ? "bg-warning" : "bg-success")} aria-hidden="true" />
      <span className={blocked ? "text-warning" : "text-success"}>{blocked ? "Blocked" : "Allowed"}</span>
    </span>
  );
}

function FilterInput({ value, onChange, label, placeholder }: {
  value: string;
  onChange: (text: string) => void;
  label: string;
  placeholder: string;
}) {
  return (
    <InputGroup className="h-9">
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
      <InputGroupInput
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => onChange("")}>
            <X />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

// ── Alert events table ────────────────────────────────────────────────────────

interface AlertEventRow {
  id: number;
  rule_id: number | null;
  rule_name: string;
  channel: string;
  snippet: string;
  has_screenshot: boolean;
  screenshot_requested: boolean;
  created_at: string;
}

function matchesAlertEvent(item: AlertEventRow, text: string): boolean {
  const q = text.toLowerCase();
  return item.rule_name.toLowerCase().includes(q) || item.snippet.toLowerCase().includes(q) || item.channel.toLowerCase().includes(q);
}

const alertColumnHelper = createDataTableColumns<AlertEventRow>();

function alertEventColumns(onPreview: (id: number) => void, onViewTimeline?: (ts: string) => void) {
  const columns = alertColumnHelper.columns([
    alertColumnHelper.accessor("created_at", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Time" />,
      cell: ({ row }) => fmtDateTime(row.original.created_at),
      meta: { className: "whitespace-nowrap font-mono text-xs tabular-nums" },
    }),
    alertColumnHelper.accessor("rule_name", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Rule" />,
      cell: ({ row }) => row.original.rule_name || "—",
      meta: { className: "whitespace-nowrap" },
    }),
    alertColumnHelper.display({
      id: "channel",
      header: "Channel",
      cell: ({ row }) => <ChannelWord channel={row.original.channel} />,
      meta: { className: "whitespace-nowrap" },
    }),
    alertColumnHelper.display({
      id: "snippet",
      header: "Matched text",
      cell: ({ row }) => row.original.snippet || "—",
      meta: { className: "max-w-80 font-mono text-xs whitespace-normal wrap-break-word" },
    }),
    alertColumnHelper.display({
      id: "screenshot",
      header: "Screenshot",
      cell: ({ row }) => {
        const r = row.original;
        return r.has_screenshot
          ? <Button variant="link" size="sm" className="h-auto p-0" onClick={() => onPreview(r.id)}>View</Button>
          : <span className="text-[13px] text-muted-foreground">{r.screenshot_requested ? "Not captured" : "Off"}</span>;
      },
      meta: { className: "whitespace-nowrap" },
    }),
  ]);
  if (!onViewTimeline) return columns;
  return [
    ...columns,
    alertColumnHelper.display({
      id: "timeline",
      header: () => <span className="sr-only">Timeline</span>,
      cell: ({ row }) => (
        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => onViewTimeline(row.original.created_at)}>Timeline</Button>
      ),
      meta: { className: "whitespace-nowrap" },
    }),
  ];
}

function AlertEventsTable({
  agentId,
  onViewTimeline,
}: {
  agentId: string;
  onViewTimeline?: (ts: string) => void;
}) {
  const [items, setItems] = useState<AlertEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewId, setPreviewId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.agentAlertRuleEvents(agentId, { limit: 500, offset: 0 }).catch(() => ({
        rows: [],
      }));
      setItems(
        (data.rows ?? []).map((r: Record<string, unknown>) => ({
          id: Number(r.id ?? 0),
          rule_id: r.rule_id != null ? Number(r.rule_id) : null,
          rule_name: String(r.rule_name ?? ""),
          channel: String(r.channel ?? ""),
          snippet: String(r.snippet ?? ""),
          has_screenshot: Boolean(r.has_screenshot),
          screenshot_requested: Boolean(r.screenshot_requested),
          created_at: String(r.created_at ?? ""),
        })),
      );
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { void load(); }, [load]);

  const columns = useMemo(() => alertEventColumns(setPreviewId, onViewTimeline), [onViewTimeline]);
  const table = useDataTable({
    data: items,
    columns,
    pageSize: 25,
    initialSorting: [{ id: "created_at", desc: true }],
    filterFn: matchesAlertEvent,
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-heading text-sm font-semibold">
          Events{" "}
          <span className="font-mono text-xs font-normal text-muted-foreground">({items.length})</span>
        </h3>
        <div className="w-full sm:max-w-xs">
          <FilterInput
            value={String(table.state.globalFilter ?? "")}
            onChange={(text) => table.setGlobalFilter(text)}
            label="Filter alert events"
            placeholder="Rule, channel, or text"
          />
        </div>
      </div>
      <div className="overflow-hidden rounded-xl bg-muted/50">
        <DataTable table={table} loading={loading} emptyText="No alerts yet." bodyClassName="[&_td]:align-top" />
      </div>
      <DataTablePagination table={table} />
      <ScreenshotDialog eventId={previewId} onClose={() => setPreviewId(null)} />
    </div>
  );
}

// ── App block events table ────────────────────────────────────────────────────

const killColumnHelper = createDataTableColumns<AppBlockEvent>();

function appBlockColumns(agentId: string) {
  return killColumnHelper.columns([
    killColumnHelper.accessor("killed_at", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Time" />,
      cell: ({ row }) => fmtDateTime(row.original.killed_at),
      meta: { className: "whitespace-nowrap font-mono text-xs tabular-nums" },
    }),
    killColumnHelper.display({
      id: "exe",
      header: "EXE",
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <AppIcon agentId={agentId} exeName={row.original.exe_name} size={16} />
          <span className="font-mono text-xs">{row.original.exe_name}</span>
        </div>
      ),
    }),
    killColumnHelper.display({
      id: "rule",
      header: "Rule",
      cell: ({ row }) => row.original.rule_name ?? <span className="text-muted-foreground">—</span>,
    }),
  ]);
}

function AppBlockEventsTable({ agentId }: { agentId: string }) {
  const [items, setItems] = useState<AppBlockEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.appBlockEventsForAgent(agentId, { limit: 500 });
      setItems(data.rows);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { void load(); }, [load]);

  const columns = useMemo(() => appBlockColumns(agentId), [agentId]);
  const table = useDataTable({
    data: items,
    columns,
    pageSize: 25,
    initialSorting: [{ id: "killed_at", desc: true }],
  });

  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-heading text-sm font-semibold">
        Kills{" "}
        <span className="font-mono text-xs font-normal text-muted-foreground">({items.length})</span>
      </h3>
      <div className="overflow-hidden rounded-xl bg-muted/50">
        <DataTable table={table} loading={loading} emptyText="No blocked apps yet." />
      </div>
      <DataTablePagination table={table} />
    </div>
  );
}

// ── Active rules summary ──────────────────────────────────────────────────────

function ActiveRules({ agentId }: { agentId: string }) {
  const [alertRules, setAlertRules] = useState<AlertRuleRow[]>([]);
  const [appRules, setAppRules] = useState<AppBlockRule[]>([]);
  const [netBlocked, setNetBlocked] = useState(false);
  const [loading, setLoading] = useState(true);

  const [netSource, setNetSource] = useState<string | null>(null);

  const [prevAgentId, setPrevAgentId] = useState(agentId);

  if (agentId !== prevAgentId) {
    setPrevAgentId(agentId);
    setLoading(true);
  }

  useEffect(() => {
    api.agentEffectiveRules(agentId)
      .then((r) => {
        setAlertRules(r.alert_rules);
        setAppRules(r.app_block_rules);
        setNetBlocked(r.internet_blocked);
        setNetSource((r as Record<string, unknown>).internet_block_source as string | null ?? null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [agentId]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="flex flex-col gap-4 pt-2">
      {/* Internet Access Section */}
      <div className="border-b border-foreground/[0.06] pb-3.5">
        <div className="mb-1.5 text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
          Internet access
        </div>
        <div className="flex items-center gap-2">
          <StatusWord blocked={netBlocked} />
          {netBlocked && netSource && netSource !== "agent" && (
            <ScopeWord kind={netSource} />
          )}
          {netBlocked && (!netSource || netSource === "agent") && (
            <span className="text-[13px] text-muted-foreground">This device</span>
          )}
        </div>
      </div>

      {/* Alert Rules Section */}
      <div className="border-b border-foreground/[0.06] pb-3.5">
        <div className="mb-1.5 text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
          Alert rules
        </div>
        {alertRules.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <div className="overflow-hidden rounded-xl bg-muted/50">
            <Table>
              <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-10 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                <TableRow className="hover:bg-transparent">
                  <TableHead>Name</TableHead>
                  <TableHead>Pattern</TableHead>
                  <TableHead>From</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_td]:px-3 [&_td]:py-3.5">
                {alertRules.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.name}</TableCell>
                    <TableCell className="font-mono text-xs">{r.pattern}</TableCell>
                    <TableCell className="whitespace-nowrap"><ScopeWord kind={r.scope_kind} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* App Blocking Section */}
      <div>
        <div className="mb-1.5 text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
          App blocking
        </div>
        {appRules.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <div className="overflow-hidden rounded-xl bg-muted/50">
            <Table>
              <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-10 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                <TableRow className="hover:bg-transparent">
                  <TableHead>App</TableHead>
                  <TableHead>Match</TableHead>
                  <TableHead>From</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_td]:px-3 [&_td]:py-3.5">
                {appRules.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <AppIcon agentId={agentId} exeName={r.exe_pattern} size={16} />
                        <span className="font-mono text-xs">{r.exe_pattern}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{r.match_mode}</TableCell>
                    <TableCell className="whitespace-nowrap"><ScopeWord kind={r.scope_kind} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main EventsTab ────────────────────────────────────────────────────────────

interface EventsTabProps {
  agentId: string;
  onViewTimeline?: (timestamp: string) => void;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details open className="group rounded-xl bg-card px-5 py-4">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-heading text-base font-medium [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown size={16} className="shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="pt-2">{children}</div>
    </details>
  );
}

export function EventsTab({ agentId, onViewTimeline }: EventsTabProps) {
  return (
    <div className="flex flex-col gap-6">
      <Section title="Active rules">
        <ActiveRules agentId={agentId} />
      </Section>

      <Tabs defaultValue="alerts">
        <TabsList aria-label="Event type">
          <TabsTrigger value="alerts">Alert events</TabsTrigger>
          <TabsTrigger value="appblock">App block kills</TabsTrigger>
        </TabsList>
        <TabsContent value="alerts">
          <AlertEventsTable agentId={agentId} onViewTimeline={onViewTimeline} />
        </TabsContent>
        <TabsContent value="appblock">
          <AppBlockEventsTable agentId={agentId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
