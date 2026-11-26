import { useQuery } from "@tanstack/react-query";
import { errorText } from "@/api";
import { ruleQueries } from "@/api/queries/rules";
import { fmtDateTime } from "@/lib/utils";
import type { AppBlockEvent, AppBlockRule } from "@/api/types";
import { appBlockTitle } from "../hooks/useAppBlockMutations";
import { HistoryDialog } from "./HistoryDialog";

const NO_EVENTS: AppBlockEvent[] = [];
const HISTORY_LIMIT = 200;
const HISTORY_PAGE = { limit: HISTORY_LIMIT };
const toEvents = (d: { rows: AppBlockEvent[] }) => d.rows;

/** Each time one app block rule closed an app on a device, newest first. */
export function AppBlockHistoryDialog({
  rule,
  onClose,
}: {
  rule: AppBlockRule | null;
  onClose: () => void;
}) {
  const historyQuery = useQuery({
    ...ruleQueries.appBlockEventsForRule(rule?.id ?? 0, HISTORY_PAGE),
    enabled: rule !== null,
    select: toEvents,
  });
  const events = historyQuery.data ?? NO_EVENTS;
  const error = historyQuery.isError ? errorText(historyQuery.error) : null;
  const unknown = error !== null || historyQuery.isPending;
  const count = events.length;

  return (
    <HistoryDialog
      open={rule !== null}
      title={`History · ${rule ? appBlockTitle(rule) : ""}`}
      summary={
        unknown || count === 0
          ? "Each time this rule closed an app, newest first."
          : `${count} ${count === 1 ? "closure" : "closures"}, newest first${count >= HISTORY_LIMIT ? `. Only the latest ${HISTORY_LIMIT} are shown` : ""}.`
      }
      loading={historyQuery.isPending && rule !== null}
      error={error}
      errorPrefix="Couldn’t load this rule’s history"
      empty={count === 0}
      emptyText="Nothing closed yet. When this rule closes an app, the time, agent and app are recorded here."
      onRetry={() => void historyQuery.refetch()}
      onClose={onClose}
    >
      <ul
        aria-label="Apps closed by this rule"
        className="max-h-[min(55dvh,30rem)] overflow-y-auto overscroll-contain rounded-xl border border-border/60 bg-muted/20"
      >
        {events.map((row) => (
          <li
            key={row.id}
            className="flex flex-col gap-1 border-b border-border/60 p-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-4"
          >
            <time
              dateTime={row.killed_at}
              className="font-sans text-xs tabular-nums sm:w-44 sm:shrink-0"
            >
              {fmtDateTime(row.killed_at)}
            </time>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {row.agent_name || "Unknown agent"}
            </span>
            <span className="min-w-0 font-sans text-xs break-all">{row.exe_name}</span>
          </li>
        ))}
      </ul>
    </HistoryDialog>
  );
}
