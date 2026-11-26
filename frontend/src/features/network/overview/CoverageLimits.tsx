import { ChevronDown } from "lucide-react";
import { Card, CardContent } from "@vantyr/ui/components/card";
import { COVERAGE_LIMITS } from "@/features/network/lib/labels";

/** What no gateway can see. Collapsed by default: it matters, but it is not the first thing to read. */
export function CoverageLimits() {
  return (
    <Card className="gap-0 py-0">
      <CardContent className="p-0">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
            What isn’t covered
            <ChevronDown
              className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <ul className="space-y-2 border-t border-border/50 px-5 py-4 text-sm text-muted-foreground">
            {COVERAGE_LIMITS.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
        </details>
      </CardContent>
    </Card>
  );
}
