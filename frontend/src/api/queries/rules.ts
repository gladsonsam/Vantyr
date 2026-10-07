import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api";
import { agentKeys } from "./agents";

type ListParams = { limit?: number; offset?: number };

/**
 * Rule lists sit under `ruleKeys.all`. Per-agent views of rules (effective rules, event feeds,
 * the internet-block toggle) sit under `agentKeys.agent(id)` so invalidating an agent covers them.
 */
export const ruleKeys = {
  all: ["rules"] as const,
  /** Alert rules list (`/alert-rules`). */
  alertRules: () => [...ruleKeys.all, "alert"] as const,
  /** Alert events: one rule's history, or the global feed. */
  alertEvents: () => [...ruleKeys.all, "alert-events"] as const,
  alertEventsForRule: (ruleId: number, params: ListParams) => [...ruleKeys.alertEvents(), "rule", ruleId, params] as const,
  alertEventsAll: (params: ListParams) => [...ruleKeys.alertEvents(), "all", params] as const,
  /** Internet block rules list (`/internet-block-rules`). */
  internetBlockRules: () => [...ruleKeys.all, "internet-block"] as const,
  /** App block rules list (`/app-block-rules`); per-agent lists nest under it. */
  appBlockRules: () => [...ruleKeys.all, "app-block"] as const,
  /** App block rules that apply to one agent (`/app-block-rules?agent_id=`). */
  appBlockRulesForAgent: (agentId: string) => [...ruleKeys.appBlockRules(), "agent", agentId] as const,
  /** Executables the server refuses to block. */
  appBlockProtectedExes: () => [...ruleKeys.all, "app-block-protected"] as const,
  /** App block kills: one rule's history, or the global feed. */
  appBlockEvents: () => [...ruleKeys.all, "app-block-events"] as const,
  appBlockEventsForRule: (ruleId: number, params: ListParams) => [...ruleKeys.appBlockEvents(), "rule", ruleId, params] as const,
  appBlockEventsAll: (params: ListParams) => [...ruleKeys.appBlockEvents(), "all", params] as const,
  /** Scheduled scripts list (`/scheduled-scripts`); their run events nest under it. */
  scheduledScripts: () => [...ruleKeys.all, "scheduled-scripts"] as const,
  scheduledScriptEventsAll: (params: ListParams) => [...ruleKeys.scheduledScripts(), "events", params] as const,
  /** Effective internet block for one agent (manual toggle or a matching rule). */
  internetBlocked: (agentId: string) => [...agentKeys.agent(agentId), "internet-blocked"] as const,
  /** Alert rules, app block rules and internet block that currently apply to one agent. */
  effectiveRules: (agentId: string) => [...agentKeys.agent(agentId), "effective-rules"] as const,
  agentAlertEvents: (agentId: string, params: ListParams) => [...agentKeys.agent(agentId), "alert-rule-events", params] as const,
  agentAppBlockEvents: (agentId: string, params: ListParams) => [...agentKeys.agent(agentId), "app-block-events", params] as const,
  /** Executable names the agent has reported running (app block suggestions). */
  knownExes: (agentId: string) => [...agentKeys.agent(agentId), "known-exes"] as const,
};

export const ruleQueries = {
  alertRules: () =>
    queryOptions({
      queryKey: ruleKeys.alertRules(),
      queryFn: () => api.alertRulesList(),
    }),
  alertEventsForRule: (ruleId: number, params: ListParams) =>
    queryOptions({
      queryKey: ruleKeys.alertEventsForRule(ruleId, params),
      queryFn: () => api.alertRuleEvents(ruleId, params),
    }),
  alertEventsAll: (params: ListParams) =>
    queryOptions({
      queryKey: ruleKeys.alertEventsAll(params),
      queryFn: () => api.alertRuleEventsAll(params),
    }),
  internetBlockRules: () =>
    queryOptions({
      queryKey: ruleKeys.internetBlockRules(),
      queryFn: () => api.internetBlockRulesList(),
    }),
  appBlockRules: () =>
    queryOptions({
      queryKey: ruleKeys.appBlockRules(),
      queryFn: () => api.appBlockRulesList(),
    }),
  appBlockRulesForAgent: (agentId: string) =>
    queryOptions({
      queryKey: ruleKeys.appBlockRulesForAgent(agentId),
      queryFn: () => api.appBlockRulesList(agentId),
    }),
  appBlockProtectedExes: () =>
    queryOptions({
      queryKey: ruleKeys.appBlockProtectedExes(),
      queryFn: () => api.appBlockProtectedExes(),
    }),
  appBlockEventsForRule: (ruleId: number, params: ListParams) =>
    queryOptions({
      queryKey: ruleKeys.appBlockEventsForRule(ruleId, params),
      queryFn: () => api.appBlockEventsForRule(ruleId, params),
    }),
  appBlockEventsAll: (params: ListParams) =>
    queryOptions({
      queryKey: ruleKeys.appBlockEventsAll(params),
      queryFn: () => api.appBlockEventsAll(params),
    }),
  scheduledScripts: () =>
    queryOptions({
      queryKey: ruleKeys.scheduledScripts(),
      queryFn: () => api.scheduledScriptsList(),
    }),
  scheduledScriptEventsAll: (params: { limit?: number }) =>
    queryOptions({
      queryKey: ruleKeys.scheduledScriptEventsAll(params),
      queryFn: () => api.scheduledScriptEventsAll(params),
    }),
  internetBlocked: (agentId: string) =>
    queryOptions({
      queryKey: ruleKeys.internetBlocked(agentId),
      queryFn: () => api.agentInternetBlockedGet(agentId),
    }),
  effectiveRules: (agentId: string) =>
    queryOptions({
      queryKey: ruleKeys.effectiveRules(agentId),
      queryFn: () => api.agentEffectiveRules(agentId),
    }),
  agentAlertEvents: (agentId: string, params: ListParams) =>
    queryOptions({
      queryKey: ruleKeys.agentAlertEvents(agentId, params),
      queryFn: () => api.agentAlertRuleEvents(agentId, params),
    }),
  agentAppBlockEvents: (agentId: string, params: ListParams) =>
    queryOptions({
      queryKey: ruleKeys.agentAppBlockEvents(agentId, params),
      queryFn: () => api.appBlockEventsForAgent(agentId, params),
    }),
  knownExes: (agentId: string) =>
    queryOptions({
      queryKey: ruleKeys.knownExes(agentId),
      queryFn: () => api.agentKnownExes(agentId),
    }),
};
