import type { AuditScope } from "./auditRows";
import { AUDIT_LIMIT, AUDIT_PAGE_SIZE } from "./auditRows";

const records = (count: number) => `${count} ${count === 1 ? "record" : "records"}`;

/** The one line above the list: what is on screen, what the search left out and what the page never loaded. */
export function auditSummary(input: {
  shown: number;
  matching: number;
  scoped: number;
  page: number;
  hiddenViews: number;
  uniformActor: string | null;
  capped: boolean;
  refreshing: boolean;
  filtering: boolean;
  failed: boolean;
}): string {
  const { shown, matching, scoped, page, hiddenViews, uniformActor, capped, refreshing, filtering, failed } = input;
  if (failed) return "Audit log unavailable";
  const parts: string[] = [];
  if (matching === 0) {
    parts.push(filtering ? "No matches" : "No records");
  } else if (matching > AUDIT_PAGE_SIZE) {
    const first = (page - 1) * AUDIT_PAGE_SIZE + 1;
    parts.push(`${first}–${first + shown - 1} of ${matching}${matching < scoped ? " matching" : ""}`);
  } else if (matching < scoped) {
    parts.push(`${matching} of ${records(scoped)}`);
  } else {
    parts.push(records(matching));
  }
  if (hiddenViews > 0) parts.push(`${hiddenViews} page ${hiddenViews === 1 ? "view" : "views"} hidden`);
  if (uniformActor) parts.push(`all by ${uniformActor}`);
  if (capped) parts.push(`newest ${AUDIT_LIMIT} loaded, older ones may exist`);
  if (refreshing) parts.push("refreshing…");
  return parts.join(" · ");
}

const SCOPE_NOUN: Record<AuditScope, string> = { all: "records", auth: "sign-in records", operator: "operator or API records" };

/** Why the list is empty, in the words of whatever narrowed it. */
export function emptyMessage(input: {
  query: string;
  status: string;
  scope: AuditScope;
  forDevice: boolean;
  hiddenViews: number;
  loaded: number;
}): { title: string; description: string } {
  const { query, status, scope, forDevice, hiddenViews, loaded } = input;
  const q = query.trim();
  if (q) {
    return { title: `Nothing matches “${q}”`, description: "Search looks at the action, user, device, IP address and detail of the loaded records." };
  }
  if (status !== "all") {
    const word = status === "ok" ? "succeeded" : status === "error" ? "failed" : status;
    return { title: `No ${word} ${forDevice ? "records" : SCOPE_NOUN[scope]}`, description: "Nothing recorded with that outcome yet." };
  }
  if (hiddenViews > 0) {
    return { title: "Only page views recorded", description: `${hiddenViews} page ${hiddenViews === 1 ? "view is" : "views are"} hidden because opening a page is rarely what you are looking for.` };
  }
  if (loaded > 0 && !forDevice && scope !== "all") {
    return { title: `No ${SCOPE_NOUN[scope]}`, description: `None among the ${loaded} loaded records.` };
  }
  return { title: "No audit records yet", description: forDevice ? "Nothing has been done to this device yet." : "Sign-ins, operator actions and API calls will appear here." };
}
