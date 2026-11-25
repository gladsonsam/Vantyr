import type { AlertRule } from "@/api/types";

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** How many alert rules target each group directly (rules for everyone or one device don't count). */
export function ruleCountsByGroup(rules: AlertRule[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rule of rules) {
    const seen = new Set<string>();
    for (const scope of rule.scopes) {
      if (scope.kind === "group" && scope.group_id && !seen.has(scope.group_id)) {
        seen.add(scope.group_id);
        counts.set(scope.group_id, (counts.get(scope.group_id) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/** The text of a failed request, whatever was thrown. */
export function messageOf(e: unknown): string {
  return String((e as Error)?.message ?? e);
}
