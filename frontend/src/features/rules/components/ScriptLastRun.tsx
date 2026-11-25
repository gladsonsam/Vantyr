import { fmtDateTime } from "@/lib/utils";
import type { LastRun } from "../hooks/useScheduledScriptRuns";
import { RUN_TONE_CLASS, runCountsSummary } from "../lib/ruleSummary";

/**
 * How the newest run went across the devices it was sent to, and when it fired. `failed` means the run feed
 * couldn't be read, which is not the same as the script never having run.
 */
export function ScriptLastRun({ run, failed }: { run: LastRun | undefined; failed: boolean }) {
  if (failed) return <span>Last run unknown: results didn’t load</span>;
  if (!run) return <span>No recent run</span>;
  const { text, tone } = runCountsSummary(run.counts);
  return (
    <span>
      <span className={`font-medium ${RUN_TONE_CLASS[tone]}`}>{text}</span>
      {" · "}
      <time dateTime={run.time} className="tabular-nums">{fmtDateTime(run.time)}</time>
    </span>
  );
}
