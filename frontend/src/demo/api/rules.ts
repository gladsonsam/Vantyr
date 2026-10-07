import type { ApiClient } from "@/api";
import type { AlertRuleEvent, AlertRuleTriggeredEvent } from "@/api/types";
import {
  demoAgents,
  demoAlertRules,
  demoAppBlockEvents,
  demoAppBlockRules,
  demoInternetBlockRules,
  demoScheduledEvents,
  demoScheduledScripts,
  isoMinutesAgo,
} from "@/demo/data";
import { asRecord } from "./helpers";
import type { DemoState } from "./state";

/** Fake alert, app-block, internet-block and scheduled-script rules endpoints. */
export function demoRulesApi(state: DemoState): Partial<ApiClient> {
  const { configuredInternet, internetConfiguration } = state;
  return {
    agentInternetBlockedGet: async (id) => configuredInternet(String(id)),
    agentInternetBlockedPut: async (id, body) => { internetConfiguration.set(String(id), Boolean(asRecord(body).blocked)); return configuredInternet(String(id)); },
    internetBlockRulesList: async () => ({ rules: demoInternetBlockRules }),
    internetBlockRulesCreate: async () => ({ id: 99 }),
    internetBlockRulesUpdate: async () => ({ ok: true }),
    internetBlockRulesDelete: async () => ({ ok: true }),
    alertRulesList: async () => ({ rules: demoAlertRules }),
    alertRulesCreate: async () => ({ id: 100 }),
    alertRulesUpdate: async () => ({ ok: true }),
    alertRulesDelete: async () => ({ ok: true }),
    appBlockRulesList: async () => ({ rules: demoAppBlockRules }),
    appBlockRulesCreate: async () => ({ id: 101 }),
    appBlockRulesUpdate: async () => ({ ok: true }),
    appBlockRulesDelete: async () => ({ ok: true }),
    scheduledScriptsList: async () => ({ scripts: demoScheduledScripts }),
    scheduledScriptsCreate: async () => ({ id: 102 }),
    scheduledScriptsUpdate: async () => ({ ok: true }),
    scheduledScriptsDelete: async () => ({ ok: true }),
    scheduledScriptsTrigger: async () => ({ ok: true, agent_count: demoAgents.length }),
    scheduledScriptEventsAll: async () => ({ rows: demoScheduledEvents() }),
    scheduledScriptEventsForScript: async () => ({ rows: demoScheduledEvents() }),
    agentKnownExes: async () => ({ exes: ["chrome.exe", "msedge.exe", "steam.exe", "Code.exe", "powershell.exe"] }),
    appBlockProtectedExes: async () => ({ protected: ["vantyr-agent.exe", "vantyr-ui.exe", "explorer.exe"] }),
    appBlockEventsForAgent: async () => ({ rows: demoAppBlockEvents() }),
    appBlockEventsForRule: async () => ({ rows: demoAppBlockEvents() }),
    appBlockEventsAll: async () => ({ rows: demoAppBlockEvents() }),
    agentEffectiveRules: async (id) => ({
      alert_rules: demoAlertRules.map((r) => ({ id: r.id, name: r.name, pattern: r.pattern, match_mode: r.match_mode, case_insensitive: r.case_insensitive, cooldown_secs: r.cooldown_secs, take_screenshot: Boolean(r.take_screenshot), metric: null, comparator: null, threshold: null, duration_secs: null })),
      app_block_rules: demoAppBlockRules,
      internet_blocked: String(id) === "sitting-room",
      internet_block_source: String(id) === "sitting-room" ? "agent" : null,
    }),
    alertRuleEvents: async () => ({ rows: alertEvents() }),
    agentAlertRuleEvents: async () => ({ rows: alertEvents() }),
    alertRuleEventsAll: async () => ({ rows: alertEvents() }),

  };
}

function alertEvents(): (AlertRuleEvent & AlertRuleTriggeredEvent)[] {
  return demoAgents.slice(0, 5).map((a, i) => ({
    id: i + 1,
    rule_id: demoAlertRules[i % demoAlertRules.length].id,
    rule_name: demoAlertRules[i % demoAlertRules.length].name,
    agent_id: a.id,
    agent_name: a.name,
    channel: i % 2 === 0 ? "url" : "keys",
    snippet: i % 2 === 0 ? "facebook.com/profile" : "[demo redacted keyword]",
    has_screenshot: false,
    screenshot_requested: false,
    created_at: isoMinutesAgo(i * 17 + 1),
  }));
}
