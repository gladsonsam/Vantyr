import type { AuditRecord } from "@/api/types";
import { formatAuditAction, isPageView } from "./auditDetail";

export type AuditScope = "all" | "auth" | "operator";

/** The most records one request loads: a list that reaches it may have older records the page never shows. */
export const AUDIT_LIMIT = 500;
export const AUDIT_PAGE_SIZE = 50;

export interface AuditRow {
  id: number;
  ts: string;
  actor: string;
  client_ip: string | null;
  agent_id: string | null;
  action: string;
  status: string;
  detail: Record<string, unknown>;
}

export const NO_ROWS: AuditRow[] = [];

export function toAuditRows(data: { rows: AuditRecord[] }): AuditRow[] {
  const list = Array.isArray(data?.rows) ? data.rows : [];
  return list.map((r) => ({
    id: Number(r.id ?? 0),
    ts: r.ts,
    actor: String(r.actor ?? "operator"),
    client_ip: r.client_ip ?? null,
    agent_id: r.agent_id ?? null,
    action: String(r.action ?? "unknown"),
    status: String(r.status ?? "ok"),
    detail: r.detail,
  }));
}

/** Rows the scope tabs and the page-views switch leave in (a device's own log ignores the scope). */
export function scopeRows(rows: AuditRow[], scope: AuditScope, forDevice: boolean, showViews: boolean): AuditRow[] {
  const visible = showViews ? rows : rows.filter((r) => !isPageView(r.action));
  if (forDevice || scope === "all") return visible;
  return visible.filter((r) => (scope === "auth" ? r.actor === "auth" : r.actor !== "auth"));
}

/** Every word typed must appear somewhere in the record: action, outcome, who, where from, which device or its detail. */
export function matchesAuditRow(row: AuditRow, query: string, deviceName: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [
    row.action,
    formatAuditAction(row.action),
    row.status,
    row.actor,
    row.client_ip ?? "",
    deviceName,
    JSON.stringify(row.detail ?? {}),
  ]
    .join("\n")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Oldest first is the same rows reversed: the server already returns them newest first. */
export function orderRows(rows: AuditRow[], newestFirst: boolean): AuditRow[] {
  return [...rows].sort((a, b) => {
    const diff = Date.parse(b.ts) - Date.parse(a.ts);
    const byTime = Number.isNaN(diff) ? 0 : diff;
    return (newestFirst ? byTime : -byTime) || (newestFirst ? b.id - a.id : a.id - b.id);
  });
}

export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
}
