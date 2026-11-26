import type { DomainMatch } from "@/features/network/runtime/types";

/** "*.example.com" reads as "this name and everything under it"; an exact match stays as written. */
export function matchText(match: DomainMatch): string {
  return match.kind === "suffix" ? `*.${match.value}` : match.value;
}
