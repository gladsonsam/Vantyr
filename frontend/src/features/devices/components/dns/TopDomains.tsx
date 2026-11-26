import { Card, CardContent } from "@vantyr/ui/components/card";
import { cn } from "@/lib/utils";
import type { DomainCount } from "@/features/network/runtime/types";

/** The most-queried domains, each with a bar scaled to the busiest one. */
export function TopDomains({
  title,
  rows,
  tone,
}: {
  title: string;
  rows: DomainCount[];
  tone: "neutral" | "blocked";
}) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <Card className="gap-0 py-0">
      <CardContent className="space-y-4 p-5">
        <h3 className="font-medium">{title}</h3>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing in this range.</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
              <li key={row.domain} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-4 text-sm">
                  <span className="truncate font-mono text-[0.8125rem]">{row.domain}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {row.count.toLocaleString()}
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      tone === "blocked" ? "bg-destructive" : "bg-primary/60",
                    )}
                    style={{ width: `${(row.count / max) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
