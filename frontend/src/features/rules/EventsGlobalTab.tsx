import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Ban, BellRing, Eye, History, SquareTerminal, Unplug, type LucideIcon } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import { Skeleton } from "@vantyr/ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@vantyr/ui/components/tabs";
import { EmptyState } from "@/components/common/EmptyState";
import { ListPagination } from "@/components/common/ListPagination";
import { RefreshButton } from "@/components/common/RefreshButton";
import { ScreenshotDialog } from "@/components/common/ScreenshotDialog";
import { fmtDateTime } from "@/lib/utils";
import { useGlobalEvents } from "./hooks/useGlobalEvents";
import { FEED_LIMIT, type EventFilter, type UnifiedEvent } from "./lib/globalEvents";

const PAGE_SIZE = 50;

const FILTER_TABS: { value: EventFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "alerts", label: "Alerts" },
  { value: "appblock", label: "App blocks" },
  { value: "scripts", label: "Scripts" },
  { value: "connections", label: "Connections" },
];

const TYPE_META: Record<UnifiedEvent["type"], { label: string; Icon: LucideIcon; className: string }> = {
  alert: { label: "Alert", Icon: BellRing, className: "text-info" },
  appblock: { label: "App block", Icon: Ban, className: "text-destructive" },
  script: { label: "Script", Icon: SquareTerminal, className: "text-success" },
  connection: { label: "Connection", Icon: Unplug, className: "text-muted-foreground" },
};

const EMPTY_TEXT: Record<EventFilter, string> = {
  all: "Events from alerts, app blocks, scripts and connections will appear here.",
  alerts: "Nothing has matched an alert rule yet.",
  appblock: "No blocked app has been closed yet.",
  scripts: "No scheduled script has run yet.",
  connections: "No agent has connected or disconnected yet.",
};

function statusClass(status: string): string {
  if (status.includes("error") || status.includes("failed")) return "text-destructive";
  if (status.includes("skipped")) return "text-muted-foreground";
  return "text-success";
}

const countLabel = (n: number) => (n >= FEED_LIMIT ? `${FEED_LIMIT}+` : String(n));

export function EventsGlobalTab() {
  const [filter, setFilter] = useState<EventFilter>("all");
  const [previewEventId, setPreviewEventId] = useState<number | null>(null);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [page, setPage] = useState(1);
  const feed = useGlobalEvents(filter, autoRefreshEnabled);

  const pagesCount = Math.max(1, Math.ceil(feed.events.length / PAGE_SIZE));
  const activePage = Math.min(page, pagesCount);
  const displayed = feed.events.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="sr-only">Rule events</h2>
        <p role="status" className="text-sm text-muted-foreground tabular-nums">
          {feed.firstLoad ? "Loading events…" : `${feed.events.length} ${feed.events.length === 1 ? "event" : "events"}${feed.capped ? ` · newest ${FEED_LIMIT} of each kind` : ""}`}
        </p>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground" title="Reload the events every 30 seconds">
            <Checkbox checked={autoRefreshEnabled} onCheckedChange={(checked) => setAutoRefreshEnabled(checked === true)} aria-label="Auto-refresh every 30 seconds" />
            Auto-refresh
          </label>
          <RefreshButton onClick={feed.refresh} loading={feed.loading} />
        </div>
      </div>

      {feed.failedFeeds.length > 0 && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span className="min-w-0 break-words">
            Couldn’t load {feed.failedFeeds.join(", ")}. {feed.allFailed ? "No events are shown." : "The rest are shown, so this list is incomplete."}
          </span>
          <Button variant="outline" size="sm" onClick={feed.refresh}>Try again</Button>
        </div>
      )}

      <Tabs value={filter} onValueChange={(value) => { setFilter(value as EventFilter); setPage(1); }} className="min-w-0">
        <TabsList aria-label="Event type" className="h-auto! w-full flex-wrap justify-start">
          {FILTER_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className="h-8! flex-none">
              {tab.label}
              {!feed.firstLoad && <span className="ml-1.5 font-mono text-xs text-muted-foreground tabular-nums">{feed.failedFilters.has(tab.value) ? "?" : countLabel(feed.counts[tab.value])}</span>}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <EventList
        filter={filter}
        loading={feed.firstLoad && feed.events.length === 0}
        hidden={feed.allFailed}
        displayed={displayed}
        page={activePage}
        pages={pagesCount}
        onPage={setPage}
        onScreenshot={setPreviewEventId}
      />
      <ScreenshotDialog eventId={previewEventId} onClose={() => setPreviewEventId(null)} />
    </div>
  );
}

function EventList({ filter, loading, hidden, displayed, page, pages, onPage, onScreenshot }: {
  filter: EventFilter;
  loading: boolean;
  /** Every feed failed: the notice above says so, an "empty" list would be a claim. */
  hidden: boolean;
  displayed: UnifiedEvent[];
  page: number;
  pages: number;
  onPage: (page: number) => void;
  onScreenshot: (eventId: number) => void;
}) {
  if (loading) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (displayed.length === 0) {
    if (hidden) return null;
    return (
      <EmptyState
        title={filter === "all" ? "No events yet" : `No ${FILTER_TABS.find((t) => t.value === filter)?.label.toLowerCase()} yet`}
        description={EMPTY_TEXT[filter]}
        icon={<History />}
        iconVariant="icon"
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-xl bg-card">
      <ul aria-label="Events, newest first">
        {displayed.map((r) => (
          <EventRow key={r.id} event={r} onScreenshot={onScreenshot} />
        ))}
      </ul>
      <ListPagination page={page} pages={pages} onPageChange={onPage} />
    </div>
  );
}

function EventRow({ event: r, onScreenshot }: { event: UnifiedEvent; onScreenshot: (eventId: number) => void }) {
  const { label, Icon, className } = TYPE_META[r.type];
  const when = fmtDateTime(r.time);
  return (
    <li className="flex flex-col gap-2 border-b border-foreground/[0.06] p-4 last:border-b-0 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs font-medium ${className}`}>
            <Icon className="size-3.5" aria-hidden /> {label}
          </span>
          <span className="min-w-0 break-words font-medium">{r.rule_name || "—"}</span>
          {r.status && <span className={`text-xs font-medium ${statusClass(r.status)}`}>{r.status}</span>}
        </div>
        <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">{r.agent_name || "Unknown agent"}</span>
          <span aria-hidden>·</span>
          <time dateTime={r.time} className="font-mono tabular-nums">{when}</time>
        </p>
        {r.detail && <EventDetail text={r.detail} />}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {r.has_screenshot && r.screenshot_id ? (
          <Button variant="ghost" size="sm" className="pointer-coarse:h-9" onClick={() => onScreenshot(r.screenshot_id!)} aria-label={`View screenshot for ${label.toLowerCase()} at ${when}`}>
            <Eye /> Screenshot
          </Button>
        ) : r.screenshot_requested ? (
          <span className="px-2 text-xs text-muted-foreground" title="This rule takes a screenshot, but none was captured for this alert">No screenshot</span>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="pointer-coarse:h-9"
          nativeButton={false}
          render={<Link aria-label={`Open ${r.agent_name || "agent"} activity at ${when}`} to={`/agents/${r.agent_id}?tab=activity&at=${encodeURIComponent(r.time)}`} />}
        >
          Activity <ArrowRight />
        </Button>
      </div>
    </li>
  );
}

/** What matched or what a script printed: two lines, with the rest one click away. */
function EventDetail({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 140 || text.includes("\n");
  return (
    <div className="mt-1.5 text-xs">
      <p className={`font-mono break-words whitespace-pre-wrap [overflow-wrap:anywhere] ${open || !long ? "" : "line-clamp-2"}`}>{text}</p>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          className="rounded-sm text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:py-2"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
