import { cn } from "@/lib/utils";
import type { StatusCounts } from "./FleetToolbar";

interface Props {
  counts: StatusCounts;
  /** Devices whose agent is behind the latest release. */
  updates: number;
}

function Stat({
  label,
  value,
  dot,
  tone,
}: {
  label: string;
  value: number;
  dot?: string;
  tone?: string;
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-2.5">
      {dot && <span className={cn("size-2 shrink-0 rounded-full", dot)} aria-hidden="true" />}
      <span className={cn("text-base font-semibold tabular-nums", tone)}>{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

/** Compact inline fleet summary: one outlined strip instead of a row of KPI tiles. */
export function FleetStatStrip({ counts, updates }: Props) {
  const online = counts.online;
  return (
    <div
      role="group"
      aria-label="Fleet summary"
      className="flex flex-wrap items-center divide-x divide-border/60 self-start rounded-xl border border-border/70 bg-card/10"
    >
      <Stat label="Devices" value={counts.all} />
      <Stat label="Online" value={online} dot="bg-success" tone={online > 0 ? "text-success" : undefined} />
      <Stat label="Offline" value={counts.offline} dot="bg-muted-foreground/50" />
      {updates > 0 && (
        <Stat label="Need update" value={updates} dot="bg-warning" tone="text-warning" />
      )}
    </div>
  );
}
