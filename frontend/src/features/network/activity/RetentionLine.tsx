import { fmtDateTime } from "@/lib/utils";
import type { EventsPage } from "@/features/network/runtime/types";

/** What is kept and how much of it is stored, so nobody assumes the log goes back further than it does. */
export function RetentionLine({ page }: { page: Pick<EventsPage, "retention" | "truncated"> }) {
  const { retention, truncated } = page;
  const stored =
    retention.capCount === null
      ? `${retention.storedCount.toLocaleString()} stored`
      : `${retention.storedCount.toLocaleString()} of ${retention.capCount.toLocaleString()} stored`;
  const parts = [
    `Keeping ${retention.keepDays} ${retention.keepDays === 1 ? "day" : "days"}`,
    stored,
    retention.oldestStoredAt ? `oldest ${fmtDateTime(retention.oldestStoredAt)}` : null,
  ].filter((part): part is string => part !== null);
  return (
    <p className="text-xs text-muted-foreground">
      {parts.join(" · ")}
      {truncated ? <span className="block">Older entries have been removed</span> : null}
    </p>
  );
}
