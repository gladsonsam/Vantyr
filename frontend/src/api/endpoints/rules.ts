import type { AlertRule, AlertRuleRow, AppBlockEvent, AppBlockRule, InternetBlockRule, ScheduledScript, ScheduledScriptEvent, ScheduledScriptSchedule, ScheduledScriptScope } from "@/api/types";
import { get, putJson, postEmpty, postJsonRes, delJson, limitOffsetQuery } from "@/api/client";

export const rulesEndpoints = {
  // ── Network policy (parental controls) ──────────────────────────────────────

  agentInternetBlockedGet: (id: string): Promise<{ blocked: boolean; source?: string | null }> =>
    get(`/agents/${id}/internet-blocked`),

  agentInternetBlockedPut: (
    id: string,
    body: { blocked: boolean },
  ): Promise<{ blocked: boolean; source?: string | null }> =>
    putJson(`/agents/${id}/internet-blocked`, body),

  internetBlockRulesList: (): Promise<{ rules: InternetBlockRule[] }> =>
    get("/internet-block-rules"),

  internetBlockRulesCreate: (body: {
    name?: string;
    scopes: { kind: string; group_id?: string; agent_id?: string }[];
    schedules?: { day_of_week: number; start_minute: number; end_minute: number }[];
  }): Promise<{ id: number }> => postJsonRes("/internet-block-rules", body),

  internetBlockRulesUpdate: (
    id: number,
    body: { enabled: boolean; schedules?: { day_of_week: number; start_minute: number; end_minute: number }[] },
  ): Promise<{ ok: boolean }> =>
    putJson(`/internet-block-rules/${id}`, body),

  internetBlockRulesDelete: (id: number): Promise<{ ok: boolean }> =>
    delJson(`/internet-block-rules/${id}`),

  alertRulesList: (): Promise<{ rules: AlertRule[] }> => get("/alert-rules"),

  alertRulesCreate: (body: {
    name: string;
    channel: string;
    pattern: string;
    match_mode: string;
    case_insensitive: boolean;
    cooldown_secs: number;
    enabled: boolean;
    take_screenshot?: boolean;
    metric?: string | null;
    comparator?: string | null;
    threshold?: number | null;
    duration_secs?: number | null;
    scopes: { kind: string; group_id?: string; agent_id?: string }[];
  }): Promise<{ id: number }> => postJsonRes("/alert-rules", body),

  alertRulesUpdate: (
    id: number,
    body: {
      name: string;
      channel: string;
      pattern: string;
      match_mode: string;
      case_insensitive: boolean;
      cooldown_secs: number;
      enabled: boolean;
      take_screenshot?: boolean;
      metric?: string | null;
      comparator?: string | null;
      threshold?: number | null;
      duration_secs?: number | null;
      scopes: { kind: string; group_id?: string; agent_id?: string }[];
    },
  ): Promise<{ ok: boolean }> => putJson(`/alert-rules/${id}`, body),

  alertRulesDelete: (id: number): Promise<{ ok: boolean }> =>
    delJson(`/alert-rules/${id}`),

  // ── App block rules ────────────────────────────────────────────────────────

  appBlockRulesList: (agentId?: string): Promise<{ rules: AppBlockRule[] }> => {
    const path = agentId ? `/app-block-rules?agent_id=${agentId}` : "/app-block-rules";
    return get(path);
  },

  appBlockRulesCreate: (body: {
    name?: string;
    exe_pattern: string;
    match_mode: "exact" | "contains";
    scopes: { kind: string; group_id?: string; agent_id?: string }[];
    schedules?: { day_of_week: number; start_minute: number; end_minute: number }[];
  }): Promise<{ id: number }> => postJsonRes("/app-block-rules", body),

  appBlockRulesUpdate: (
    id: number,
    body: {
      enabled?: boolean;
      name?: string;
      exe_pattern?: string;
      match_mode?: "exact" | "contains";
      scopes?: { kind: string; group_id?: string; agent_id?: string }[];
      schedules?: { day_of_week: number; start_minute: number; end_minute: number }[];
    },
  ): Promise<{ ok: boolean }> => putJson(`/app-block-rules/${id}`, body),

  appBlockRulesDelete: (id: number): Promise<{ ok: boolean }> =>
    delJson(`/app-block-rules/${id}`),

  // ── Scheduled Scripts ───────────────────────────────────────────────────────

  scheduledScriptsList: (): Promise<{ scripts: ScheduledScript[] }> =>
    get("/scheduled-scripts"),

  scheduledScriptsCreate: (body: {
    name: string;
    shell: string;
    script: string;
    timeout_secs?: number;
    scopes: ScheduledScriptScope[];
    schedules: ScheduledScriptSchedule[];
  }): Promise<{ id: number }> => postJsonRes("/scheduled-scripts", body),

  scheduledScriptsUpdate: (
    id: number,
    body: {
      enabled?: boolean;
      name?: string;
      shell?: string;
      script?: string;
      timeout_secs?: number;
      scopes?: ScheduledScriptScope[];
      schedules?: ScheduledScriptSchedule[];
    },
  ): Promise<{ ok: boolean }> => putJson(`/scheduled-scripts/${id}`, body),

  scheduledScriptsDelete: (id: number): Promise<{ ok: boolean }> =>
    delJson(`/scheduled-scripts/${id}`),

  scheduledScriptsTrigger: (id: number): Promise<{ ok: boolean; agent_count: number }> =>
    postEmpty(`/scheduled-scripts/${id}/trigger`),

  scheduledScriptEventsAll: (
    params?: { limit?: number },
  ): Promise<{ rows: ScheduledScriptEvent[] }> =>
    get(`/scheduled-script-events${limitOffsetQuery(params)}`),

  scheduledScriptEventsForScript: (
    scriptId: number,
    params?: { limit?: number },
  ): Promise<{ rows: ScheduledScriptEvent[] }> =>
    get(`/scheduled-scripts/${scriptId}/events${limitOffsetQuery(params)}`),

  agentKnownExes: (agentId: string): Promise<{ exes: string[] }> =>
    get(`/agents/${agentId}/known-exes`),

  appBlockProtectedExes: (): Promise<{ protected: string[] }> =>
    get("/app-block-rules/protected"),

  appBlockEventsForAgent: (
    agentId: string,
    params?: { limit?: number; offset?: number },
  ): Promise<{ rows: AppBlockEvent[] }> =>
    get(`/agents/${agentId}/app-block-events${limitOffsetQuery(params)}`),

  appBlockEventsForRule: (
    ruleId: number,
    params?: { limit?: number; offset?: number },
  ): Promise<{ rows: AppBlockEvent[] }> =>
    get(`/app-block-rules/${ruleId}/events${limitOffsetQuery(params)}`),

  appBlockEventsAll: (
    params?: { limit?: number; offset?: number },
  ): Promise<{ rows: AppBlockEvent[] }> =>
    get(`/app-block-events${limitOffsetQuery(params)}`),

  agentEffectiveRules: (agentId: string): Promise<{
    alert_rules: AlertRuleRow[];
    app_block_rules: AppBlockRule[];
    internet_blocked: boolean;
  }> => get(`/agents/${agentId}/effective-rules`),

  alertRuleEvents: (
    ruleId: number,
    params?: { limit?: number; offset?: number },
  ): Promise<{ rows: Record<string, unknown>[] }> => {
    const q = new URLSearchParams();
    q.set("limit", String(params?.limit ?? 500));
    q.set("offset", String(params?.offset ?? 0));
    return get(`/alert-rules/${ruleId}/events?${q.toString()}`);
  },

  agentAlertRuleEvents: (
    agentId: string,
    params?: { limit?: number; offset?: number },
  ): Promise<{ rows: Record<string, unknown>[] }> => {
    const q = new URLSearchParams();
    q.set("limit", String(params?.limit ?? 500));
    q.set("offset", String(params?.offset ?? 0));
    return get(`/agents/${agentId}/alert-rule-events?${q.toString()}`);
  },

  alertRuleEventsAll: (
    params?: { limit?: number; offset?: number },
  ): Promise<{ rows: Record<string, unknown>[] }> => {
    const q = new URLSearchParams();
    q.set("limit", String(params?.limit ?? 500));
    q.set("offset", String(params?.offset ?? 0));
    return get(`/alert-rule-events?${q.toString()}`);
  },
};
