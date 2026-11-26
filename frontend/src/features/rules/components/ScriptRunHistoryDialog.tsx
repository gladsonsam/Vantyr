import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { errorText } from "@/api";
import { ruleQueries } from "@/api/queries/rules";
import { fmtDateTime } from "@/lib/utils";
import type { ScheduledScript, ScheduledScriptEvent } from "@/api/types";
import { RUN_TONE_CLASS, runStatus } from "../lib/ruleSummary";
import { HistoryDialog } from "./HistoryDialog";

const NO_EVENTS: ScheduledScriptEvent[] = [];
const HISTORY_LIMIT = 200;
const HISTORY_PAGE = { limit: HISTORY_LIMIT };
const toEvents = (d: { rows: ScheduledScriptEvent[] }) => d.rows;

/** Each run of one script on each device, newest first, with what it printed. */
export function ScriptRunHistoryDialog({
  script,
  onClose,
}: {
  script: ScheduledScript | null;
  onClose: () => void;
}) {
  const query = useQuery({
    ...ruleQueries.scheduledScriptEventsForScript(script?.id ?? 0, HISTORY_PAGE),
    enabled: script !== null,
    select: toEvents,
  });
  const events = query.data ?? NO_EVENTS;
  const error = query.isError ? errorText(query.error) : null;
  const count = events.length;

  return (
    <HistoryDialog
      open={script !== null}
      title={`Run history · ${script?.name ?? ""}`}
      summary={
        error !== null || query.isPending || count === 0
          ? "Each run on each device, newest first."
          : `${count} ${count === 1 ? "run" : "runs"}, newest first${count >= HISTORY_LIMIT ? `. Only the latest ${HISTORY_LIMIT} are shown` : ""}.`
      }
      loading={query.isPending && script !== null}
      error={error}
      errorPrefix="Couldn’t load this script’s runs"
      empty={count === 0}
      emptyText="No runs yet. When this script is sent to a device, the result and its output appear here."
      onRetry={() => void query.refetch()}
      onClose={onClose}
    >
      <ul
        aria-label="Runs of this script"
        className="max-h-[min(55dvh,30rem)] overflow-y-auto overscroll-contain rounded-xl border border-border/60 bg-muted/20"
      >
        {events.map((row) => (
          <RunRow key={`${row.agent_id}-${row.expected_fire_time}`} row={row} />
        ))}
      </ul>
    </HistoryDialog>
  );
}

function RunRow({ row }: { row: ScheduledScriptEvent }) {
  const status = runStatus(row.status);
  return (
    <li className="flex flex-col gap-1 border-b border-border/60 p-3 last:border-b-0">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className={`text-sm font-medium ${RUN_TONE_CLASS[status.tone]}`}>{status.label}</span>
        <span className="min-w-0 truncate text-sm">{row.agent_name || "Unknown agent"}</span>
        <time
          dateTime={row.expected_fire_time}
          className="font-sans text-xs text-muted-foreground tabular-nums"
        >
          {fmtDateTime(row.expected_fire_time)}
        </time>
      </div>
      <RunOutput status={row.status} output={row.output} />
    </li>
  );
}

/** What the script printed: a few lines, with the rest one click away. */
function RunOutput({ status, output }: { status: string; output: string | null }) {
  const [open, setOpen] = useState(false);
  if (!output) {
    return (
      <p className="text-xs text-muted-foreground">
        {status === "fired"
          ? "Waiting for the device to report back."
          : status === "skipped_offline"
            ? "The device was offline, so it wasn’t sent."
            : "No output."}
      </p>
    );
  }
  const long = output.length > 240 || output.split("\n").length > 4;
  return (
    <div className="text-xs">
      <pre
        className={`font-sans break-words whitespace-pre-wrap [overflow-wrap:anywhere] ${open || !long ? "" : "line-clamp-4"}`}
      >
        {output}
      </pre>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          className="rounded-sm text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:py-2"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Show less" : "Show all output"}
        </button>
      )}
    </div>
  );
}
