import type { DnsStats, StatsWindow } from "@/features/network/runtime/types";

/**
 * The honest wording for a statistics window that may not cover everything that was asked.
 * `unknown` is a conservative may-be-incomplete warning: it is not proof of eviction or its cause.
 */
export function shortenedWindowText(window: StatsWindow): string {
  if (window.limitedBy === "unknown") return "This window may be incomplete";
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

/** True only when every bucket carries its own blocked count (the demo). The real server sends totals only. */
export function seriesHasBlocked(series: DnsStats["series"]): boolean {
  return series.length > 0 && series.every((bucket) => typeof bucket.blocked === "number");
}
