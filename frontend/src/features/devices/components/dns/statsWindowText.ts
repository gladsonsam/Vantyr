import type { StatsWindow } from "@/features/network/runtime/types";

/** The honest wording for a statistics window that reaches back less far than was asked. */
export function shortenedWindowText(window: StatsWindow): string {
  const days = window.retainedDays;
  const unit = days === 1 ? "day" : "days";
  const reason =
    window.limitedBy === "count_cap"
      ? "event count limit"
      : window.limitedBy === "days"
        ? "retention limit"
        : null;
  return reason
    ? `Showing the last ${days} ${unit} — older history was removed (${reason})`
    : `Showing the last ${days} ${unit} — older history is not available`;
}
