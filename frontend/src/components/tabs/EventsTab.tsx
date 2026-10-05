import { ChevronDown, Search, X, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCollection, type UseCollectionCollectionProps } from "../../hooks/useCollection";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, apiUrl } from "../../lib/api";
import type { AppBlockEvent, AlertRuleRow, AppBlockRule } from "../../lib/types";
import { AppIcon } from "../common/AppIcon";
import { fmtDateTime } from "../../lib/utils";
import { alertChannelLabel } from "../../lib/alertChannels";
import { cn } from "@/lib/utils";

// ── Screenshot preview modal ──────────────────────────────────────────────────

function ScreenshotModal({ eventId, onClose }: { eventId: number | null; onClose: () => void }) {
  return (
    <Dialog open={eventId != null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Screenshot</DialogTitle>
        </DialogHeader>
        {eventId != null && (
          <div className="text-center">
            <img
              src={apiUrl(`/alert-rule-events/${eventId}/screenshot`)}
              alt="Alert screenshot"
              className="max-h-[70vh] max-w-full rounded-md object-contain"
            />
          </div>
        )}
        <DialogFooter>
          {eventId != null && (
            <Button
              variant="outline"
              render={
                <a href={apiUrl(`/alert-rule-events/${eventId}/screenshot`)} target="_blank" rel="noopener noreferrer" />
              }
            >
              <ExternalLink /> Open in new tab
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Shared bits ───────────────────────────────────────────────────────────────

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

  const { items: displayed, collectionProps, filterProps, paginationProps } = useCollection(items, {
    filtering: {
      empty: "No alerts yet",
      noMatch: "No matches",
      filteringFunction: (item, text) => {
        const q = text.toLowerCase();
        return item.rule_name.toLowerCase().includes(q) || item.snippet.toLowerCase().includes(q) || item.channel.toLowerCase().includes(q);
      },
    },
    pagination: { pageSize: 25 },
    sorting: { defaultState: { sortingColumn: { sortingField: "created_at" }, isDescending: true } },
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
            value={filterProps.filteringText}
            onChange={(text) => filterProps.onChange({ detail: { filteringText: text } })}
            label="Filter alert events"
            placeholder="Rule, channel, or text"
          />
        </div>
      </div>
      <div className="overflow-hidden rounded-xl bg-muted/50">
        <Table>
          <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
            <TableRow className="hover:bg-transparent">
              <SortTh label="Time" field="created_at" collectionProps={collectionProps} />
              <SortTh label="Rule" field="rule_name" collectionProps={collectionProps} />
              <TableHead>Channel</TableHead>
              <TableHead>Matched text</TableHead>
              <TableHead>Screenshot</TableHead>
              {onViewTimeline && <TableHead><span className="sr-only">Timeline</span></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody className="[&_td]:px-3 [&_td]:py-3.5 [&_td]:align-top">
            {loading && displayed.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={onViewTimeline ? 6 : 5}>
                  <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                    <Spinner /> Loading…
                  </div>
                </TableCell>
              </TableRow>
            ) : displayed.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={onViewTimeline ? 6 : 5}>
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No alerts yet.
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              displayed.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums">{fmtDateTime(r.created_at)}</TableCell>
                  <TableCell className="whitespace-nowrap">{r.rule_name || "—"}</TableCell>
                  <TableCell className="whitespace-nowrap"><ChannelWord channel={r.channel} /></TableCell>
                  <TableCell className="max-w-80 font-mono text-xs whitespace-normal wrap-break-word">{r.snippet || "—"}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {r.has_screenshot
                      ? <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setPreviewId(r.id)}>View</Button>
                      : <span className="text-[13px] text-muted-foreground">{r.screenshot_requested ? "Not captured" : "Off"}</span>}
                  </TableCell>
                  {onViewTimeline ? (
                    <TableCell className="whitespace-nowrap">
                      <Button variant="link" size="sm" className="h-auto p-0" onClick={() => onViewTimeline(r.created_at)}>Timeline</Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <Pager {...paginationProps} />
      <ScreenshotModal eventId={previewId} onClose={() => setPreviewId(null)} />
    </div>
  );
}

// ── App block events table ────────────────────────────────────────────────────

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

  const { items: displayed, collectionProps, paginationProps } = useCollection(items, {
    pagination: { pageSize: 25 },
    sorting: { defaultState: { sortingColumn: { sortingField: "killed_at" }, isDescending: true } },
  });

  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-heading text-sm font-semibold">
        Kills{" "}
        <span className="font-mono text-xs font-normal text-muted-foreground">({items.length})</span>
      </h3>
      <div className="overflow-hidden rounded-xl bg-muted/50">
        <Table>
          <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
            <TableRow className="hover:bg-transparent">
              <SortTh label="Time" field="killed_at" collectionProps={collectionProps} />
              <TableHead>EXE</TableHead>
              <TableHead>Rule</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_td]:px-3 [&_td]:py-3.5">
            {loading && displayed.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3}>
                  <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                    <Spinner /> Loading…
                  </div>
                </TableCell>
              </TableRow>
            ) : displayed.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3}>
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No blocked apps yet.
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              displayed.map((r, i) => (
                <TableRow key={`${r.killed_at}-${r.exe_name}-${i}`}>
                  <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums">{fmtDateTime(r.killed_at)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <AppIcon agentId={agentId} exeName={r.exe_name} size={16} />
                      <span className="font-mono text-xs">{r.exe_name}</span>
                    </div>
                  </TableCell>
                  <TableCell>{r.rule_name ?? <span className="text-muted-foreground">—</span>}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <Pager {...paginationProps} />
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
