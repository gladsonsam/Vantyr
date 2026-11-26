import { errorText, isApiError } from "@/api";
import type { DroppedPolicyContent } from "@/api/queries/network";

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Clear text for a failed read of a stored revision or diff. */
export function readError(error: unknown, what = "revision"): string {
  if (isApiError(error)) {
    if (error.status === 400) return `That ${what} request was malformed.`;
    if (error.status === 404) {
      return `This ${what} is not available. It may have been pruned from history, belong to another household, or be unreadable.`;
    }
    if (error.status === 403) return "You don’t have permission to read policy for this household.";
  }
  return errorText(error);
}

export function droppedText(item: DroppedPolicyContent): string {
  switch (item.kind) {
    case "person_rules":
      return plural(item.count, "person rule");
    case "exceptions":
      return plural(item.count, "exception");
    case "category_matchers":
      return plural(item.count, "category rule");
    case "any_matchers":
      return plural(item.count, "match-everything rule");
    case "baseline_allow":
      return plural(item.count, "baseline allow rule");
  }
}

export function scopeLabel(scope: string): string {
  if (scope === "baseline") return "Baseline";
  if (scope.startsWith("profile:")) return `Profile: ${scope.slice("profile:".length)}`;
  return scope;
}

export function formatSeconds(secs: number): string {
  if (secs % 86400 === 0) return plural(secs / 86400, "day");
  if (secs % 3600 === 0) return plural(secs / 3600, "hour");
  if (secs % 60 === 0) return plural(secs / 60, "minute");
  return plural(secs, "second");
}
