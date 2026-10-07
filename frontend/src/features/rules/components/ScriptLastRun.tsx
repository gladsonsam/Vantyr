import { fmtDateTime } from "@/lib/utils";
import type { LastRuns } from "../hooks/useScheduledScriptRuns";

function runStatusClass(status: string): string {
  if (status.includes("error") || status.includes("failed")) return "text-destructive";
  return "text-success";
}

/** The "Last Run Status" cell: status hue on text plus the run time, or a dash when never run. */
export function ScriptLastRun({ run }: { run: LastRuns[number] | undefined }) {
  if (!run) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`text-xs font-medium ${runStatusClass(run.status)}`}>{run.status}</span>
      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{fmtDateTime(run.time)}</span>
    </div>
  );
}
