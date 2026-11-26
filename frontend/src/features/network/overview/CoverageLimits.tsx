import { ChevronDown } from "lucide-react";
import { COVERAGE_LIMITS } from "@/features/network/lib/labels";

/** What no gateway can see. Collapsed by default: it matters, but it is not the first thing to read. */
export function CoverageLimits() {
  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card/10">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-base font-semibold transition-colors hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
          What isn’t covered
          <ChevronDown
            className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <ul className="divide-y divide-border/50 border-t border-border/50 text-sm text-muted-foreground">
          {COVERAGE_LIMITS.map((limit) => (
            <li key={limit} className="px-5 py-3">
              {limit}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
