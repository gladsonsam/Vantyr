import { useState } from "react";
import { Circle, ShieldOff } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { cn } from "@/lib/utils";
import type { DomainCount } from "@/features/network/runtime/types";

const FIRST = 5;
const MAX = 10;

/** The most-queried domains: count and share, with a thin bar scaled to the busiest one. */
export function TopDomains({
  title,
  rows,
  tone,
  total,
  noun = "observations",
}: {
  title: string;
  rows: DomainCount[];
  tone: "neutral" | "blocked";
  /** What the share is a share of (all queries, or all blocked ones). */
  total: number;
  /** What the counts are, for the heading and tooltips. These are never visits. */
  noun?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const max = Math.max(1, ...rows.map((row) => row.count));
  const shown = rows.slice(0, expanded ? MAX : FIRST);
  const blocked = tone === "blocked";
  const Icon = blocked ? ShieldOff : Circle;
  return (
    <div className="rounded-xl border border-border/70 bg-card/10 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-medium">{title}</h3>
        <span
          title={`${total.toLocaleString()} ${noun}`}
          className={cn("text-sm font-medium tabular-nums", blocked ? "text-destructive" : "text-primary")}
        >
          {total.toLocaleString()}
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">{noun}</span>
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">Nothing in this range.</p>
      ) : (
        <ul className="mt-4 space-y-3.5">
          {shown.map((row) => (
            <li key={row.domain} className="space-y-1.5">
              <div className="flex items-center gap-2.5 text-sm">
                <Icon
                  className={cn(
                    "shrink-0",
                    blocked ? "size-3.5 text-destructive" : "size-2 fill-primary text-primary",
                  )}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]">
                  {row.domain}
                </span>
                <span
                  title={`Seen ${row.count.toLocaleString()} times`}
                  className={cn(
                    "shrink-0 tabular-nums",
                    blocked ? "text-destructive" : "text-foreground",
                  )}
                >
                  {row.count.toLocaleString()}
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {total === 0 ? "0" : ((row.count / total) * 100).toFixed(1)}%
                  </span>
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn("h-full rounded-full", blocked ? "bg-destructive" : "bg-primary")}
                  style={{ width: `${(row.count / max) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      {rows.length > FIRST ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-3 -ml-2"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      ) : null}
    </div>
  );
}
