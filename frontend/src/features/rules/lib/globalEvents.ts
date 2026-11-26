import type {
  AgentSessionEvent,
  AlertRuleTriggeredEvent,
  AppBlockEvent,
  ScheduledScriptEvent,
} from "@/api/types";

export type EventFilter = "all" | "alerts" | "appblock" | "scripts" | "connections";

export interface UnifiedEvent {
  id: string;
  type: "alert" | "appblock" | "script" | "connection";
  agent_id: string;
  agent_name: string;
  rule_name: string;
  detail: string;
  time: string;
  status?: string;
  screenshot_id?: number;
  has_screenshot?: boolean;
  /** The rule asks for a screenshot, so a missing one means the capture failed. */
  screenshot_requested?: boolean;
}

export const FEED_LIMIT = 500;
export const FEED_PAGE = { limit: FEED_LIMIT };
export const NO_EVENTS: UnifiedEvent[] = [];

export function toAlertEvents(data: { rows: AlertRuleTriggeredEvent[] }): UnifiedEvent[] {
  return (data.rows ?? []).map((r) => ({
    id: `a-${r.id}`,
    type: "alert" as const,
    agent_id: String(r.agent_id ?? ""),
    agent_name: String(r.agent_name ?? ""),
    rule_name: String(r.rule_name ?? ""),
    detail: String(r.snippet ?? ""),
    time: String(r.created_at ?? ""),
    screenshot_id: r.has_screenshot ? Number(r.id) : undefined,
    has_screenshot: Boolean(r.has_screenshot),
    screenshot_requested: Boolean(r.screenshot_requested),
  }));
}

export function toBlockEvents(data: { rows: AppBlockEvent[] }): UnifiedEvent[] {
  return data.rows.map((r) => ({
    id: `b-${r.id}`,
    type: "appblock" as const,
    agent_id: r.agent_id,
    agent_name: r.agent_name,
    rule_name: r.rule_name ?? r.exe_name,
    detail: r.exe_name,
    time: r.killed_at,
  }));
}

export function toScriptEvents(data: { rows: ScheduledScriptEvent[] }): UnifiedEvent[] {
  return data.rows.map((r) => ({
    id: `s-${r.script_id}-${r.agent_id}-${r.expected_fire_time}`,
    type: "script" as const,
    agent_id: r.agent_id,
    agent_name: r.agent_name,
    rule_name: `${r.rule_name || "Unknown script"}${r.is_manual ? " (run manually)" : ""}`,
    detail: r.output || "No output",
    status: r.status,
    time: r.expected_fire_time,
  }));
}

export function toSessionEvents(data: { rows: AgentSessionEvent[] }): UnifiedEvent[] {
  const sess: UnifiedEvent[] = [];
  for (const r of data.rows) {
    sess.push({
      id: `conn-${r.id}`,
      type: "connection" as const,
      agent_id: r.agent_id,
      agent_name: r.agent_name,
      rule_name: "Came online",
      detail: "",
      time: r.connected_at,
    });
    if (r.disconnected_at) {
      sess.push({
        id: `disconn-${r.id}`,
        type: "connection" as const,
        agent_id: r.agent_id,
        agent_name: r.agent_name,
        rule_name: "Went offline",
        detail: "",
        time: r.disconnected_at,
      });
    }
  }
  return sess;
}

/** Each feed is best-effort: one that fails shows no rows while the others still render. */
export function feedRows(query: { isError: boolean; data?: UnifiedEvent[] }): UnifiedEvent[] {
  return query.isError ? NO_EVENTS : (query.data ?? NO_EVENTS);
}
