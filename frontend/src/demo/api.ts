import type { ApiClient } from "../lib/api";
import { publishServerVersion } from "../lib/serverVersionStore";
import {
  demoActivity,
  demoAgents,
  demoAgentInfo,
  demoAlertRules,
  demoAppBlockEvents,
  demoAppBlockRules,
  demoGroups,
  demoInternetBlockRules,
  demoKeys,
  demoScheduledEvents,
  demoScheduledScripts,
  demoSoftware,
  demoUrls,
  demoUser,
  demoUsers,
  demoWindows,
  isoHoursAgo,
  isoMinutesAgo,
} from "./data";

type DemoFn = (...args: unknown[]) => Promise<unknown>;

export function createDemoApi(realApi: ApiClient): ApiClient {
  const overrides: Record<string, DemoFn> = {
    authStatus: async () => ({ authenticated: true, password_required: false }),
    authConfig: async () => ({ oidc_enabled: false }),
    login: async () => undefined,
    logout: async () => undefined,
    me: async () => demoUser,
    twofaStatus: async () => ({ enabled: false, pending: false }),
    twofaSetup: async () => ({ secret: "JBSWY3DPEHPK3PXP", otpauth_uri: "otpauth://totp/Vantyr:demo?secret=JBSWY3DPEHPK3PXP&issuer=Vantyr" }),
    twofaEnable: async () => ({ ok: true, recovery_codes: ["abcd-efgh", "jkmn-pqrs", "tuvw-xy23", "4567-89ab", "cdef-ghjk"] }),
    twofaDisable: async () => ({ ok: true }),
    agentsOverview: async () => ({ agents: demoAgents }),
    agentIconGet: async (id) => ({ icon: demoAgents.find((a) => a.id === id)?.icon ?? null }),
    agentIconPut: async (_id, icon) => ({ icon }),
    agentGroupsForAgent: async () => ({ groups: demoGroups.slice(0, 2) }),
    windows: async (id, params) => ({ rows: page(demoWindows(String(id), 120), params) }),
    keys: async (id, params) => ({ rows: page(demoKeys(String(id), 80), params) }),
    urls: async (id, params) => ({ rows: page(demoUrls(String(id), 120), params) }),
    activity: async (id, params) => ({ rows: page(demoActivity(String(id), 80), params) }),
    agentInfo: async (id) => ({ info: demoAgentInfo[String(id)] ?? null }),
    agentMetrics: async (id, fromIso, toIso) => {
      const to = typeof toIso === "string" ? new Date(toIso).getTime() : Date.now();
      const from = typeof fromIso === "string" ? new Date(fromIso).getTime() : to - 24 * 3600 * 1000;
      const span = Math.max(60_000, to - from);
      const n = 240;
      const step = span / n;
      const memTotalMb = 16_384;
      const diskTotalGb = 475.5;
      const seed = String(id).length;
      const points = Array.from({ length: n }, (_, i) => {
        const t = Math.floor((from + i * step) / 1000);
        const phase = (i / n) * Math.PI * 2;
        const cpu = Math.max(2, Math.min(98, 28 + 22 * Math.sin(phase * 3 + seed) + 14 * Math.sin(phase * 11) + (Math.random() * 10 - 5)));
        const memPct = Math.max(20, Math.min(95, 55 + 12 * Math.sin(phase * 2 + seed) + (Math.random() * 6 - 3)));
        const diskPct = Math.max(40, Math.min(92, 68 + (i / n) * 4));
        return {
          t,
          cpu_pct: Math.round(cpu * 10) / 10,
          mem_pct: Math.round(memPct * 10) / 10,
          mem_used_mb: Math.round((memTotalMb * memPct) / 100),
          mem_total_mb: memTotalMb,
          disk_pct: Math.round(diskPct * 10) / 10,
          disk_used_gb: Math.round(((diskTotalGb * diskPct) / 100) * 10) / 10,
          disk_total_gb: diskTotalGb,
        };
      });
      return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), bucket_secs: Math.round(step / 1000), points };
    },
    topUrls: async (id) => ({
      rows: demoUrls(String(id), 12).map((u, index) => ({
        url: u.url,
        visit_count: 35 - index * 2,
        last_ts: u.ts,
      })),
    }),
    topWindows: async (id) => ({
      rows: demoWindows(String(id), 12).map((w, index) => ({
        app: w.app,
        title: w.title,
        focus_count: 28 - index,
        last_ts: w.ts,
      })),
    }),
    clearAgentHistory: async () => ({ cleared_rows: 240 }),
    retentionGlobalGet: async () => ({ keylog_days: 14, window_days: 30, url_days: 30 }),
    retentionGlobalPut: async (body) => body,
    retentionAgentGet: async () => ({
      global: { keylog_days: 14, window_days: 30, url_days: 30 },
      override: null,
    }),
    retentionAgentPut: async (_id, body) => ({
      global: { keylog_days: 14, window_days: 30, url_days: 30 },
      override: body,
    }),
    retentionAgentDelete: async () => ({
      global: { keylog_days: 14, window_days: 30, url_days: 30 },
      override: null,
    }),
    wakeAgent: async (id) => ({
      ok: true,
      mac: demoAgentInfo[String(id)]?.adapters?.[0]?.mac ?? "02-00-5E-10-00-00",
      broadcast: "255.255.255.255",
      port: 9,
    }),
    localUiPasswordGlobalGet: async () => ({ password_set: true }),
    localUiPasswordGlobalPut: async (body) => ({ password_set: Boolean(asRecord(body).password) }),
    localUiPasswordAgentGet: async () => ({ global: { password_set: true }, override: null }),
    localUiPasswordAgentPut: async (_id, body) => ({
      global: { password_set: true },
      override: { password_set: Boolean(asRecord(body).password) },
    }),
    localUiPasswordAgentDelete: async () => ({ global: { password_set: true }, override: null }),
    agentAutoUpdateGlobalGet: async () => ({ enabled: true }),
    agentAutoUpdateGlobalPut: async (body) => ({ enabled: Boolean(asRecord(body).enabled) }),
    agentAutoUpdateAgentGet: async () => ({ global: { enabled: true }, override: null }),
    agentAutoUpdateAgentPut: async (_id, body) => ({
      global: { enabled: true },
      override: { enabled: Boolean(asRecord(body).enabled) },
    }),
    agentAutoUpdateAgentDelete: async () => ({ global: { enabled: true }, override: null }),
    agentUpdateNow: async () => ({ ok: true }),
    urlCategorizationStatusGet: async () => ({
      settings: {
        enabled: true,
        auto_update: true,
        source_url: "https://demo.invalid/ut1.tar.gz",
        last_update_at: isoHoursAgo(18),
        last_update_error: null,
      },
      active_release: { sha256: "demo" },
      counts: { categories: 84, domains: 138_000, urls: 42_000 },
      job: null,
    }),
    urlCategorizationSettingsPut: async () => ({ ok: true }),
    urlCategorizationUpdateNow: async () => ({ ok: true }),
    urlCategorizationCategoriesGet: async () => ({
      categories: [
        { key: "productivity", label: "Productivity", enabled: true, description: "Work tools and docs" },
        { key: "social_networks", label: "Social networks", enabled: true, description: "Social media sites" },
        { key: "information", label: "Information", enabled: true, description: "News and reference sites" },
      ],
    }),
    urlCategorizationCategoriesPut: async (body) => body,
    urlCategorizationOverridesList: async () => ({
      rows: [
        {
          id: 1,
          kind: "domain",
          value: "github.com",
          category_key: "productivity",
          category_label: "Productivity",
          note: "Demo override",
          created_at: isoHoursAgo(5),
        },
      ],
    }),
    urlCategorizationOverridesUpsert: async () => ({ ok: true }),
    urlCategorizationOverridesDelete: async () => ({ ok: true }),
    urlCategorizationRecalcUrlVisits: async () => ({ enqueued: 500 }),
    urlCategorizationRecalcUrlSessions: async () => ({ updated: 200 }),
    agentUrlCategoryStats: async () => ({
      rows: [
        { category: "Productivity", visit_count: 42, last_ts: isoMinutesAgo(8) },
        { category: "Information", visit_count: 23, last_ts: isoMinutesAgo(19) },
        { category: "Social networks", visit_count: 4, last_ts: isoMinutesAgo(55) },
      ],
    }),
    agentUrlCategoryBackfill: async () => ({ enqueued: 250 }),
    agentAnalyticsUrlCategories: async () => ({
      rows: [
        { category_key: "productivity", category_label: "Productivity", time_ms: 7_200_000, visit_count: 34, last_ts: isoMinutesAgo(4) },
        { category_key: "information", category_label: "Information", time_ms: 2_100_000, visit_count: 13, last_ts: isoMinutesAgo(11) },
      ],
    }),
    agentAnalyticsUrlSites: async () => ({
      rows: [
        { hostname: "github.com", category_key: "productivity", category_label: "Productivity", time_ms: 4_200_000, visit_count: 18, last_ts: isoMinutesAgo(4) },
        { hostname: "cloudscape.design", category_key: "productivity", category_label: "Productivity", time_ms: 1_800_000, visit_count: 9, last_ts: isoMinutesAgo(19) },
      ],
    }),
    urlCustomCategoriesList: async () => ({
      categories: [{ id: 1, label_en: "Design tools", description_en: "Design and product work", display_order: 10, hidden: false, ut1_keys: ["productivity"] }],
    }),
    urlCustomCategoriesCreate: async () => ({ id: 2 }),
    urlCustomCategoriesUpdate: async () => ({ ok: true }),
    urlCustomCategoriesDelete: async () => ({ ok: true }),
    urlCustomCategoriesPutMembers: async () => ({ ok: true, count: 1 }),
    agentAnalyticsUrlSessions: async (id) => ({
      rows: demoUrls(String(id), 20).map((u, index) => ({
        id: index + 1,
        url: u.url,
        hostname: new URL(u.url).hostname,
        ts_start: u.ts,
        ts_end: isoMinutesAgo(index * 13),
        duration_ms: 180_000 + index * 30_000,
        user: u.user,
        category_key: u.category_key,
        category_label: u.category,
        browser: u.browser,
        title: u.title,
      })),
    }),
    agentInternetBlockedGet: async (id) => ({ blocked: String(id) === "sitting-room", source: String(id) === "sitting-room" ? "demo rule" : null }),
    agentInternetBlockedPut: async (_id, body) => ({ blocked: Boolean(asRecord(body).blocked), source: "demo override" }),
    internetBlockRulesList: async () => ({ rules: demoInternetBlockRules }),
    internetBlockRulesCreate: async () => ({ id: 99 }),
    internetBlockRulesUpdate: async () => ({ ok: true }),
    internetBlockRulesDelete: async () => ({ ok: true }),
    getAgentSetupHints: async () => ({ mdns: "advertising", agent_wss_url: "wss://demo.vantyr.local/ws/agent", mdns_port: 5353 }),
    createAgentEnrollmentToken: async (body) => ({
      id: "demo-token",
      enrollment_token: "123456",
      uses: Number(asRecord(body).uses ?? 1),
      expires_at: isoHoursAgo(-24),
      note: typeof asRecord(body).note === "string" ? String(asRecord(body).note) : null,
    }),
    listAgentEnrollmentTokens: async () => ({
      tokens: [{ id: "demo-token", uses_remaining: 1, created_at: isoHoursAgo(1), expires_at: isoHoursAgo(-24), note: "Demo enrollment", used_count: 0, last_used_at: null }],
    }),
    revokeAgentEnrollmentToken: async () => ({ ok: true }),
    revokeAllAgentEnrollmentTokens: async () => ({ ok: true, revoked: 1 }),
    listAgentEnrollmentTokenUses: async () => ({ uses: [] }),
    listAgentEnrollmentClaims: async () => ({
      claims: [
        {
          id: "demo-claim",
          invite_id: "demo-token",
          status: "pending",
          requested_name: "NEW-LAPTOP",
          hostname: "NEW-LAPTOP",
          os: "Windows 11",
          agent_version: "0.2.9",
          client_ip: "10.0.8.44",
          discovered_server: "demo.vantyr.local",
          created_at: isoMinutesAgo(12),
          approved_by: null,
          approved_at: null,
          rejected_by: null,
          rejected_at: null,
          agent_id: null,
          error: null,
        },
      ],
    }),
    approveAgentEnrollmentClaim: async () => ({ ok: true, agent_id: "new-laptop" }),
    rejectAgentEnrollmentClaim: async () => ({ ok: true }),
    revokeAgentCredentials: async () => ({ ok: true }),
    deleteAgents: async (ids) => ({ ok: true, deleted: Array.isArray(ids) ? ids.length : 0 }),
    settingsVersionGet: async () => {
      const result = {
        server_version: "0.2.9-demo",
        latest_server_release: "0.2.9",
        server_update_available: false,
        latest_agent_version: "0.2.9",
        releases_url: "https://github.com/",
      };
      publishServerVersion(result);
      return result;
    },
    storageUsage: async () => ({
      database_bytes: 512 * 1024 * 1024,
      public_tables_bytes: 410 * 1024 * 1024,
      other_bytes: 102 * 1024 * 1024,
      tables: [
        { name: "window_events", bytes: 120 * 1024 * 1024 },
        { name: "url_visits", bytes: 96 * 1024 * 1024 },
        { name: "key_sessions", bytes: 48 * 1024 * 1024 },
      ],
    }),
    capabilities: async () => ({ remote_script: true, scheduler_timezone: "Australia/Perth" }),
    agentSoftware: async (id) => ({ rows: demoSoftware(String(id)), last_captured_at: isoMinutesAgo(7), total: 5, limit: 100, offset: 0 }),
    collectAgentSoftware: async () => ({ ok: true }),
    runAgentScript: async () => ({ ok: true, stdout: "Demo script completed", stderr: "", exit_code: 0 }),
    agentLogSources: async () => ({
      sources: [
        { id: "agent", label: "Agent log", path: "C:\\ProgramData\\Vantyr\\agent.log" },
        { id: "ui", label: "Settings UI log", path: "C:\\ProgramData\\Vantyr\\ui.log" },
      ],
    }),
    audit: async () => ({
      rows: [
        { id: 1, ts: isoMinutesAgo(5), actor: "admin", action: "demo.refresh", status: "ok", target: "dashboard" },
        { id: 2, ts: isoMinutesAgo(22), actor: "operator", action: "agent.wake", status: "ok", target: "KIOSK-LOBBY" },
      ],
    }),
    agentLogTail: async (id, params) => ({ kind: String(asRecord(params).kind ?? "agent"), text: `[demo] ${id} connected\n[demo] telemetry batch uploaded\n` }),
    bulkAgentScript: async (body) => ({
      results: asStringArray(asRecord(body).agent_ids).map((agentId) => ({ agent_id: agentId, ok: true, stdout: "Demo bulk script completed" })),
    }),
    usersList: async () => ({ users: demoUsers }),
    userCreate: async () => ({ id: "demo-user-new" }),
    userSetPassword: async () => ({ ok: true }),
    userSetRole: async () => ({ ok: true }),
    userUpdateProfile: async (_id, body) => ({ ok: true, id: String(_id), username: String(asRecord(body).username ?? "admin"), display_name: String(asRecord(body).display_name ?? "Demo Admin"), display_icon: asRecord(body).display_icon as string | null }),
    userDelete: async () => ({ ok: true }),
    userIdentities: async () => ({ identities: [] }),
    userIdentityLink: async () => ({ ok: true }),
    identityUnlink: async () => ({ ok: true }),
    agentGroupsList: async () => ({ groups: demoGroups }),
    agentGroupsCreate: async () => ({ id: "grp-demo-new" }),
    agentGroupsUpdate: async () => ({ ok: true }),
    agentGroupsDelete: async () => ({ ok: true }),
    agentGroupMembers: async () => ({ agent_ids: demoAgents.slice(0, 3).map((a) => a.id) }),
    agentGroupMembersAdd: async (body) => ({ added: asStringArray(asRecord(body).agent_ids).length }),
    agentGroupMemberRemove: async () => ({ ok: true }),
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
    agentSessionsAll: async () => ({
      rows: demoAgents.map((a, i) => ({
        id: i + 1,
        agent_id: a.id,
        agent_name: a.name,
        connected_at: a.last_connected_at ?? isoHoursAgo(i + 1),
        disconnected_at: a.online ? null : a.last_disconnected_at,
      })),
    }),
    agentKnownExes: async () => ({ exes: ["chrome.exe", "msedge.exe", "steam.exe", "Code.exe", "powershell.exe"] }),
    appBlockProtectedExes: async () => ({ protected: ["vantyr-agent.exe", "vantyr-ui.exe", "explorer.exe"] }),
    appBlockEventsForAgent: async () => ({ rows: demoAppBlockEvents() }),
    appBlockEventsForRule: async () => ({ rows: demoAppBlockEvents() }),
    appBlockEventsAll: async () => ({ rows: demoAppBlockEvents() }),
    agentEffectiveRules: async (id) => ({
      alert_rules: demoAlertRules.map((r) => ({ id: r.id, name: r.name, pattern: r.pattern, match_mode: r.match_mode, case_insensitive: r.case_insensitive, cooldown_secs: r.cooldown_secs, take_screenshot: Boolean(r.take_screenshot), scope_kind: "all" })),
      app_block_rules: demoAppBlockRules,
      internet_blocked: String(id) === "sitting-room",
    }),
    alertRuleEvents: async () => ({ rows: alertEvents() }),
    agentAlertRuleEvents: async () => ({ rows: alertEvents() }),
    alertRuleEventsAll: async () => ({ rows: alertEvents() }),
  };

  return new Proxy(realApi, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in overrides) return overrides[prop];
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return async () => ({ ok: true });
      }
      return value;
    },
  }) as ApiClient;
}

function page<T>(rows: T[], params: unknown): T[] {
  const p = asRecord(params);
  const offset = numberOr(p.offset, 0);
  const limit = numberOr(p.limit, rows.length);
  return rows.slice(offset, offset + limit);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function alertEvents(): Record<string, unknown>[] {
  return demoAgents.slice(0, 5).map((a, i) => ({
    id: i + 1,
    rule_id: demoAlertRules[i % demoAlertRules.length].id,
    rule_name: demoAlertRules[i % demoAlertRules.length].name,
    agent_id: a.id,
    agent_name: a.name,
    channel: i % 2 === 0 ? "url" : "keys",
    snippet: i % 2 === 0 ? "facebook.com/profile" : "[demo redacted keyword]",
    ts: isoMinutesAgo(i * 17 + 1),
    created_at: isoMinutesAgo(i * 17 + 1),
  }));
}
