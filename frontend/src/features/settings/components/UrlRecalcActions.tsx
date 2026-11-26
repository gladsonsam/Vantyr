import { useState } from "react";
import { Button } from "@vantyr/ui/components/button";
import { Spinner } from "@vantyr/ui/components/spinner";
import { errorText } from "@/api/client";
import {
  useRecalcUrlSessionsMutation,
  useRecalcUrlVisitsMutation,
} from "@/api/queries/urlCategories";

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Re-runs categorization over history already stored, and says how much it touched. */
export function UrlRecalcActions({ onError }: { onError: (message: string) => void }) {
  const recalcVisits = useRecalcUrlVisitsMutation();
  const recalcSessions = useRecalcUrlSessionsMutation();
  const [result, setResult] = useState<string | null>(null);

  const run = async (action: () => Promise<string>) => {
    setResult(null);
    try {
      setResult(await action());
    } catch (e) {
      onError(errorText(e));
    }
  };
  const busy = recalcVisits.isPending || recalcSessions.isPending;

  return (
    <section aria-labelledby="override-apply-heading" className="flex flex-col gap-3">
      <div>
        <h3 id="override-apply-heading" className="font-heading text-base font-medium">
          Apply to history
        </h3>
        <p className="text-sm text-muted-foreground">
          Changes to overrides and lists apply to new visits. Use these to update what is already
          stored (up to 100,000 recent items).
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const { enqueued } = await recalcVisits.mutateAsync();
              return `Queued ${plural(enqueued, "visit", "visits")} that had no category for categorizing.`;
            })
          }
        >
          {recalcVisits.isPending && <Spinner />} Categorize uncategorized visits
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const { updated } = await recalcSessions.mutateAsync();
              return `Re-checked recent sessions against the overrides and lists. Updated ${plural(updated, "session", "sessions")}.`;
            })
          }
        >
          {recalcSessions.isPending && <Spinner />} Re-categorize recent sessions
        </Button>
      </div>
      {result ? (
        <p role="status" className="text-sm text-muted-foreground">
          {result}
        </p>
      ) : null}
    </section>
  );
}
