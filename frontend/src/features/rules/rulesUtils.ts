import type { AlertRuleScope } from "@/api/types";

export type ScopeFormRow = { kind: "all" | "group" | "agent"; group_id: string; agent_id: string };

export function emptyScopeRow(): ScopeFormRow {
  return { kind: "all", group_id: "", agent_id: "" };
}

export function scopesToForm(scopes: AlertRuleScope[]): ScopeFormRow[] {
  if (!scopes || scopes.length === 0) return [emptyScopeRow()];
  return scopes.map((s) => ({
    kind: s.kind as "all" | "group" | "agent",
    group_id: s.group_id ?? "",
    agent_id: s.agent_id ?? "",
  }));
}

export function formScopesToApi(rows: ScopeFormRow[]): AlertRuleScope[] {
  return rows.map((r) => {
    if (r.kind === "all") return { kind: "all" };
    if (r.kind === "group") return { kind: "group", group_id: r.group_id };
    return { kind: "agent", agent_id: r.agent_id };
  });
}

export const timeToMinute = (t: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const hhRaw = parseInt(m[1], 10);
  const mmRaw = parseInt(m[2], 10);
  const mm = Math.max(0, Math.min(59, mmRaw));
  if (hhRaw === 24 && mm === 0) return 1440;
  const hh = Math.max(0, Math.min(23, hhRaw));
  return hh * 60 + mm;
};

export const minuteToTime = (min: number): string => {
  const m = Math.max(0, Math.min(1440, Math.floor(min)));
  if (m === 1440) return "24:00";
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${hh}:${mm}`;
};

export const DAY_OPTIONS = [
  { label: "Sunday", value: "0" },
  { label: "Monday", value: "1" },
  { label: "Tuesday", value: "2" },
  { label: "Wednesday", value: "3" },
  { label: "Thursday", value: "4" },
  { label: "Friday", value: "5" },
  { label: "Saturday", value: "6" },
];
