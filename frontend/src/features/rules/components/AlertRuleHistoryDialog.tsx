import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Eye } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@vantyr/ui/components/dialog";
import { Skeleton } from "@vantyr/ui/components/skeleton";
import { ScreenshotDialog } from "@/components/common/ScreenshotDialog";
import { fmtDateTime } from "@/lib/utils";
import type { AlertRule } from "@/api/types";
import type { AlertRuleHistoryRow } from "../hooks/useAlertRuleHistory";
import { ruleTitle } from "../lib/alertRuleSummary";

/** Trigger history of one alert rule, with a screenshot preview for events that captured one. */
export function AlertRuleHistoryDialog({ rule, events, loading, error, truncated, onRetry, onClose }: {
  rule: AlertRule | null;
  events: AlertRuleHistoryRow[];
  loading: boolean;
  /** Why the history could not be loaded, when it could not. */
  error: string | null;
  /** The list stops at the newest events; older ones exist. */
  truncated: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
  const [previewEventId, setPreviewEventId] = useState<number | null>(null);

  return (
    <>
      <Dialog open={rule !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-[min(48rem,calc(100%-2rem))]">
          <DialogHeader>
            <DialogTitle className="break-words">History · {rule ? ruleTitle(rule) : ""}</DialogTitle>
            <DialogDescription>
              {historySummary(events.length, error !== null || loading, truncated)}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <span className="min-w-0 break-words">Couldn’t load this rule’s history: {error}</span>
              <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>
            </div>
          )}
          {loading ? (
            <Skeleton className="h-48 w-full rounded-xl" />
          ) : events.length > 0 ? (
            <ul aria-label="Alerts raised by this rule" className="max-h-[min(55dvh,30rem)] overflow-y-auto overscroll-contain rounded-xl bg-muted/50">
              {events.map((row) => (
                <HistoryRow key={row.id} row={row} onScreenshot={setPreviewEventId} />
              ))}
            </ul>
          ) : error ? null : (
            <p className="rounded-xl bg-muted/50 px-4 py-8 text-center text-sm text-muted-foreground">
              No alerts yet. When this rule matches, the time, agent and matched text are recorded here.
            </p>
          )}
          <DialogFooter className="-bottom-4">
            <Button variant="outline" onClick={onClose}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ScreenshotDialog eventId={previewEventId} onClose={() => setPreviewEventId(null)} />
    </>
  );
}

function historySummary(count: number, unknown: boolean, truncated: boolean): string {
  if (unknown) return "Alerts this rule has raised, newest first.";
  if (count === 0) return "Alerts this rule has raised will appear here.";
  return `${count} ${count === 1 ? "alert" : "alerts"}, newest first${truncated ? ". Older ones are not shown" : ""}.`;
}

function HistoryRow({ row, onScreenshot }: { row: AlertRuleHistoryRow; onScreenshot: (eventId: number) => void }) {
  const when = fmtDateTime(row.created_at);
  return (
    <li className="flex flex-col gap-2 border-b border-foreground/[0.06] p-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 sm:w-44 sm:shrink-0">
        <p className="font-mono text-xs tabular-nums">{when}</p>
        <p className="truncate text-sm font-medium">{row.agent_name || "Unknown agent"}</p>
      </div>
      <p className="min-w-0 flex-1 font-mono text-xs break-words [overflow-wrap:anywhere]">
        {row.snippet || <span className="text-muted-foreground">No matched text recorded</span>}
      </p>
      <div className="flex shrink-0 items-center gap-1">
        {row.has_screenshot ? (
          <Button variant="ghost" size="sm" aria-label={`View screenshot from ${when}`} onClick={() => onScreenshot(row.id)}>
            <Eye /> Screenshot
          </Button>
        ) : row.screenshot_requested ? (
          <span className="px-2 text-xs text-muted-foreground" title="This rule takes a screenshot, but none was captured for this alert">No screenshot</span>
        ) : null}
        {row.agent_id && (
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={<Link aria-label={`Open ${row.agent_name || "agent"} activity at ${when}`} to={`/agents/${row.agent_id}?tab=activity&at=${encodeURIComponent(row.created_at)}`} />}
          >
            Activity <ArrowRight />
          </Button>
        )}
      </div>
    </li>
  );
}
