import type { StatsWindow } from "@/features/network/runtime/types";

/** The honest wording for a statistics window that reaches back less far than was asked. */
export function shortenedWindowText(window: StatsWindow): string {
  const days = window.retainedDays;
  const unit = days === 1 ? "day" : "days";
  return `Showing the last ${days} ${unit} — only ${days} ${unit} ${days === 1 ? "is" : "are"} retained`;
}

