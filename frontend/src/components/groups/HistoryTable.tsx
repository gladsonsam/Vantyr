import { ChevronLeft, ChevronRight, RefreshCw, Search, SearchX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCollection } from "@/hooks/useCollection";
import { alertChannelLabel } from "@/lib/alertChannels";
import { cn, fmtDateTime } from "@/lib/utils";

export interface AlertRuleHistoryEventRow {
  id: number;
  agent_id: string;
  agent_name: string;
  rule_name: string;
  channel: string;
  snippet: string;
  has_screenshot: boolean;
  screenshot_requested: boolean;
  created_at: string;
}

interface HistoryTableProps {
  loading: boolean;
  events: AlertRuleHistoryEventRow[];
  showRuleName: boolean;
  onPreviewScreenshot: (eventId: number) => void;
  onNavigateToAgent: (agentId: string) => void;
  onGoToTimeline: (agentId: string, timestamp: string) => void;
  onRefresh?: () => void;
  title?: string;
  description?: string;
  pageSize?: number;
  emptyText?: string;
}

function ScreenshotCell({
  eventId,
  hasScreenshot,
  screenshotRequested,
  onPreview,
}: {
  eventId: number;
  hasScreenshot: boolean;
  screenshotRequested: boolean;
  onPreview: (id: number) => void;
}) {
  if (hasScreenshot) {
    return (
      <Button variant="link" size="sm" onClick={() => onPreview(eventId)}>
        View
      </Button>
    );
  }
  if (screenshotRequested) {
    return (
      <span
        className="text-xs text-muted-foreground"
        title="Screenshot was requested but not captured (may have failed or still in progress)."
      >
        Not captured
      </span>
    );
  }
  return (
    <span
      className="text-xs text-muted-foreground"
      title='Enable "Take screenshot on trigger" on the alert rule to capture screenshots.'
    >
      Off
    </span>
  );
}

export function HistoryTable({
  loading,
  events,
  showRuleName,
  onPreviewScreenshot,
  onNavigateToAgent,
  onGoToTimeline,
  onRefresh,
  title,
  description,
  pageSize = 15,
  emptyText,
}: HistoryTableProps) {
  const { items, filterProps, paginationProps } = useCollection(events, {
    filtering: {
      empty: emptyText ?? "No triggers yet",
      noMatch: "No rows match the filter",
      filteringFunction: (item, filteringText) => {
        const q = filteringText.toLowerCase();
        return (
          item.agent_name.toLowerCase().includes(q) ||
          item.rule_name.toLowerCase().includes(q) ||
          item.snippet.toLowerCase().includes(q) ||
          item.channel.toLowerCase().includes(q)
        );
      },
    },
    pagination: { pageSize },
    sorting: {
      defaultState: {
        sortingColumn: { sortingField: "created_at" },
        isDescending: true,
      },
    },
  });

  const { currentPageIndex, pagesCount, onChange } = paginationProps;
  const goToPage = (page: number) => onChange({ detail: { currentPageIndex: page } });

  return (
    <div className="flex flex-col gap-4">
      {(title || onRefresh) && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            {title && (
              <h2 className="text-lg font-semibold tracking-tight">
                {title}{" "}
                {events.length > 0 && (
                  <span className="font-mono text-sm font-normal text-muted-foreground tabular-nums">
                    ({events.length})
                  </span>
                )}
              </h2>
            )}
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {onRefresh && (
            <Button variant="outline" size="sm" disabled={loading} onClick={onRefresh}>
              <RefreshCw className={cn(loading && "animate-spin")} /> Refresh
            </Button>
          )}
        </div>
      )}

      <InputGroup className="h-9 sm:max-w-md">
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Filter trigger history"
          placeholder={
            showRuleName
              ? "Search by rule, agent, channel, or matched text"
              : "Search by agent, channel, or matched text"
          }
          value={filterProps.filteringText}
          onChange={(event) =>
            filterProps.onChange({ detail: { filteringText: event.target.value } })
          }
        />
        {filterProps.filteringText && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              aria-label="Clear filter"
              onClick={() => filterProps.onChange({ detail: { filteringText: "" } })}
            >
              <X />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>

      {items.length === 0 ? (
        <Empty className="bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchX />
            </EmptyMedia>
            <EmptyTitle>{loading ? "Loading…" : "No events matched"}</EmptyTitle>
            <EmptyDescription>
              {loading
                ? title
                  ? `Loading ${title.toLowerCase()}…`
                  : "Loading trigger history…"
                : (emptyText ?? "No triggers yet")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl bg-card">
          <Table>
            <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5!">Time</TableHead>
                {showRuleName && <TableHead>Rule</TableHead>}
                <TableHead>Agent</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Matched text</TableHead>
                <TableHead>Screenshot</TableHead>
                <TableHead className="pr-5! text-right">Timeline</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_td]:px-3 [&_td]:py-3">
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="pl-5! font-mono text-xs whitespace-nowrap tabular-nums">
                    {fmtDateTime(item.created_at)}
                  </TableCell>
                  {showRuleName && <TableCell>{item.rule_name || "—"}</TableCell>}
                  <TableCell>
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0"
                      onClick={() => onNavigateToAgent(item.agent_id)}
                    >
                      {item.agent_name.trim()
                        ? item.agent_name
                        : `${item.agent_id.slice(0, 8)}…`}
                    </Button>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {alertChannelLabel(item.channel)}
                  </TableCell>
                  <TableCell className="max-w-72">
                    <span className="block truncate font-mono text-xs" title={item.snippet || "—"}>
                      {item.snippet || "—"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <ScreenshotCell
                      eventId={item.id}
                      hasScreenshot={item.has_screenshot}
                      screenshotRequested={item.screenshot_requested}
                      onPreview={onPreviewScreenshot}
                    />
                  </TableCell>
                  <TableCell className="pr-5! text-right">
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0"
                      aria-label={`View timeline for event ${item.id}`}
                      onClick={() => onGoToTimeline(item.agent_id, item.created_at)}
                    >
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {pagesCount > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          <span className="font-mono text-xs tabular-nums" aria-live="polite">
            Page {currentPageIndex} of {pagesCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            aria-label="Previous page"
            disabled={currentPageIndex <= 1}
            onClick={() => goToPage(currentPageIndex - 1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="Next page"
            disabled={currentPageIndex >= pagesCount}
            onClick={() => goToPage(currentPageIndex + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
      )}
    </div>
  );
}
