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
    // Demo-only mock; keep the channel list in sync with PROVIDER_CATALOG in
    // server/src/notify/mod.rs (the real source of truth) when channels change.
    notificationsStatus: async () => ({
      any_enabled: true,
      providers: [
        { id: "email", label: "Email (SMTP)", description: "Send alert emails through any SMTP server.", env_keys: ["SMTP_HOST", "SMTP_FROM", "SMTP_TO", "SMTP_PORT", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_TLS", "SMTP_SUBJECT_PREFIX"], docs_url: "", enabled: true },
        { id: "slack", label: "Slack", description: "Post alerts to a Slack channel via an Incoming Webhook.", env_keys: ["SLACK_WEBHOOK_URL"], docs_url: "https://api.slack.com/messaging/webhooks", enabled: true },
        { id: "discord", label: "Discord", description: "Post alerts to a Discord channel via a channel Webhook.", env_keys: ["DISCORD_WEBHOOK_URL"], docs_url: "https://support.discord.com/hc/en-us/articles/228383668", enabled: false },
        { id: "teams", label: "Microsoft Teams", description: "Post alerts to a Teams channel via an Incoming Webhook.", env_keys: ["TEAMS_WEBHOOK_URL"], docs_url: "https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/connectors-using", enabled: false },
        { id: "telegram", label: "Telegram", description: "Send alerts to a Telegram chat through a bot.", env_keys: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"], docs_url: "https://core.telegram.org/bots", enabled: false },
        { id: "ntfy", label: "ntfy", description: "Push alerts to an ntfy topic (ntfy.sh or self-hosted).", env_keys: ["NTFY_URL", "NTFY_TOKEN"], docs_url: "https://docs.ntfy.sh/", enabled: false },
        { id: "pushover", label: "Pushover", description: "Send push notifications to your devices via Pushover.", env_keys: ["PUSHOVER_TOKEN", "PUSHOVER_USER_KEY"], docs_url: "https://pushover.net/api", enabled: false },
        { id: "webhook", label: "Webhook", description: "POST the raw alert JSON to any HTTP endpoint.", env_keys: ["NOTIFY_WEBHOOK_URL", "NOTIFY_WEBHOOK_AUTH_HEADER"], docs_url: "", enabled: false },
        { id: "home_assistant", label: "Home Assistant", description: "Fire a custom event into Home Assistant for your automations.", env_keys: ["HOME_ASSISTANT_URL", "HOME_ASSISTANT_ACCESS_TOKEN", "HOME_ASSISTANT_EVENT_TYPE", "HOME_ASSISTANT_SKIP_TLS_VERIFY"], docs_url: "https://www.home-assistant.io/docs/automation/trigger/#event-trigger", enabled: false },
      ],
    }),
    notificationsTest: async () => ({
      all_ok: true,
      results: [
        { id: "email", ok: true, error: null },
        { id: "slack", ok: true, error: null },
      ],
    }),
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

    // ── Screen history / "Recall" ──
    historyFrames: async (_id, fromIso, toIso, limit) => {
      const to = typeof toIso === "string" ? new Date(toIso).getTime() : Date.now();
      const from = typeof fromIso === "string" ? new Date(fromIso).getTime() : to - 24 * 3600 * 1000;
      let frames = demoFramesList(from, to);
      if (typeof limit === "number" && limit > 0) frames = frames.slice(0, limit);
      return {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        count: frames.length,
        frames,
      };
    },
    historyFrameAt: async (_id, atIso) => {
      const at = typeof atIso === "string" ? new Date(atIso).getTime() : Date.now();
      const t = Math.round(at / DEMO_FRAME_STEP_MS) * DEMO_FRAME_STEP_MS;
      return { frame: demoFrame(t) };
    },
    historySearch: async (_id, query, fromIso, toIso, limit) => {
      const q = String(query ?? "").trim();
      const to = typeof toIso === "string" ? new Date(toIso).getTime() : Date.now();
      const from = typeof fromIso === "string" ? new Date(fromIso).getTime() : to - 24 * 3600 * 1000;
      const cap = typeof limit === "number" && limit > 0 ? limit : 100;
      const results = q
        ? demoFramesList(from, to)
            .filter((f) => f.has_ocr)
            .slice(0, Math.min(8, cap))
            .map((f, i) => ({
              ...f,
              rank: Math.round((1 - i * 0.09) * 1000) / 1000,
              snippet: `…recognized on-screen text matching [[[${q}]]] in the active window…`,
            }))
        : [];
      return { query: q, from: new Date(from).toISOString(), to: new Date(to).toISOString(), count: results.length, results };
    },
    historySegments: async (_id, day) => {
      const d = typeof day === "string" && day ? day : new Date().toISOString().slice(0, 10);
      return { day: d, count: demoSegments(d).length, segments: demoSegments(d) };
    },
    historyDaySummary: async (_id, day) => {
      const d = typeof day === "string" && day ? day : new Date().toISOString().slice(0, 10);
      const segs = demoSegments(d);
      const byCat: Record<string, number> = {};
      const byApp: Record<string, number> = {};
      let active = 0;
      for (const s of segs) {
        const secs = Math.round((new Date(s.end_ts).getTime() - new Date(s.start_ts).getTime()) / 1000);
        active += secs;
        byCat[s.category] = (byCat[s.category] ?? 0) + secs;
        if (s.app) byApp[s.app] = (byApp[s.app] ?? 0) + secs;
      }
      const topApps = Object.entries(byApp)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([app, seconds]) => ({ app, seconds }));
      return {
        day: d,
        summary: {
          day: d,
          narrative:
            "A focused day centred on Visual Studio Code — building out the Recall feature through the morning, with a midday stretch of research and a few Slack threads, then documentation into the afternoon. Attention held up well, with only short breaks.",
          totals: { active_seconds: active, segment_count: segs.length, by_category: byCat },
          top_apps: topApps,
          highlights: segs
            .slice()
            .sort(
              (a, b) =>
                new Date(b.end_ts).getTime() - new Date(b.start_ts).getTime() -
                (new Date(a.end_ts).getTime() - new Date(a.start_ts).getTime()),
            )
            .slice(0, 3)
            .map((s) => ({ label: s.summary ?? s.category, category: s.category, start_ts: s.start_ts, end_ts: s.end_ts })),
          source: "rule",
          updated_at: new Date().toISOString(),
        },
      };
    },
    historyActivity: async (_id, fromIso, toIso, buckets) => {
      const to = typeof toIso === "string" ? new Date(toIso).getTime() : Date.now();
      const from = typeof fromIso === "string" ? new Date(fromIso).getTime() : to - 24 * 3600 * 1000;
      const n = typeof buckets === "number" && buckets > 0 ? buckets : 120;
      const bs = Math.max(60, Math.floor(Math.max(60_000, to - from) / 1000 / n));
      const start = Math.floor(from / 1000 / bs) * bs;
      const points: { t: number; count: number }[] = [];
      for (let t = start; t * 1000 < to; t += bs) {
        const d = new Date(t * 1000);
        const hr = d.getHours() + d.getMinutes() / 60;
        // Diurnal curve: awake/working roughly 6:00–20:00, peak early afternoon.
        const day = Math.max(0, Math.sin(((hr - 6) / 14) * Math.PI));
        const ebb = (Math.sin(t / (bs * 6)) + 1) / 2; // natural ebb and flow within the day
        const count = Math.round(day * (0.45 + 0.55 * ebb) * 8);
        if (count > 0) points.push({ t, count });
      }
      return {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        bucket_secs: bs,
        points,
      };
    },
    // Synchronous string-returning method (unlike the async data methods above).
    historyBlobUrl: ((_id: unknown, frameId: unknown) =>
      demoFrameDataUri(Number(frameId))) as unknown as DemoFn,
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

const DEMO_FRAME_STEP_MS = 90_000;

/** One synthetic keyframe at epoch-millis `t`. Id is derived from `t` so it is
 *  stable across `historyFrames` / `historyFrameAt` / the blob URL. */
function demoFrame(t: number): {
  id: number;
  captured_at: string;
  monitor: number;
  w: number;
  h: number;
  phash: string;
  has_ocr: boolean;
} {
  const id = Math.round(t / 1000);
  return {
    id,
    captured_at: new Date(t).toISOString(),
    monitor: 0,
    w: 1600,
    h: 900,
    phash: String((id * 2654435761) % 1_000_000_000),
    has_ocr: id % 3 === 0,
  };
}

/** Synthetic frame list across [fromMs, toMs], one every DEMO_FRAME_STEP_MS. */
function demoFramesList(fromMs: number, toMs: number): ReturnType<typeof demoFrame>[] {
  const frames: ReturnType<typeof demoFrame>[] = [];
  const start = Math.ceil(fromMs / DEMO_FRAME_STEP_MS) * DEMO_FRAME_STEP_MS;
  for (let t = start; t <= toMs && frames.length < 2000; t += DEMO_FRAME_STEP_MS) {
    frames.push(demoFrame(t));
  }
  return frames;
}

/** Synthetic activity segments for a given day (YYYY-MM-DD). */
function demoSegments(day: string): {
  id: number;
  start_ts: string;
  end_ts: string;
  category: string;
  app: string | null;
  title: string | null;
  summary: string | null;
  distraction_score: number;
  source: string;
}[] {
  const plan: [string, string, string, number, number][] = [
    // [category, app, title, minutes, distraction]
    ["dev", "Code.exe", "RecallPage.tsx — vantyr", 95, 0.1],
    ["terminal", "WindowsTerminal.exe", "cargo check -p vantyr-server", 25, 0.1],
    ["browsing", "chrome.exe", "postgres partitioning docs", 30, 0.5],
    ["comms", "slack.exe", "#eng-vantyr", 20, 0.4],
    ["media", "chrome.exe", "youtube.com — lofi", 15, 0.85],
    ["docs", "Code.exe", "11-screen-history-plan.md", 40, 0.2],
    ["dev", "Code.exe", "screen_narrative.rs", 70, 0.1],
  ];
  // Anchor the sequence to end at ~now (clamped to the selected day) so the segments
  // fall inside the rolling frame window — makes click-to-jump land on a real frame.
  const spanMin = plan.reduce((n, p) => n + p[3], 0) + (plan.length - 1) * 3;
  const dayEnd = new Date(`${day}T23:59:59`).getTime();
  const anchorEnd = Math.min(dayEnd, Date.now());
  let t = anchorEnd - spanMin * 60_000;
  return plan.map(([category, app, title, mins, distraction], i) => {
    const start = t;
    const end = t + mins * 60_000;
    t = end + 3 * 60_000;
    return {
      id: i + 1,
      start_ts: new Date(start).toISOString(),
      end_ts: new Date(end).toISOString(),
      category,
      app,
      title,
      summary: `${app} — ${title}`,
      distraction_score: distraction,
      source: "rule",
    };
  });
}

/** A mock "screenshot" as an inline SVG data URI, keyed off the frame id. */
function demoFrameDataUri(frameId: number): string {
  const hue = ((frameId % 360) + 360) % 360;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='1600' height='900'>` +
    `<rect width='100%' height='100%' fill='hsl(${hue},28%,11%)'/>` +
    `<rect width='1600' height='56' fill='hsl(${hue},38%,18%)'/>` +
    `<circle cx='40' cy='28' r='9' fill='#20dd8f'/>` +
    `<text x='68' y='37' fill='#e6e6e6' font-family='monospace' font-size='24'>Demo desktop &#183; frame ${frameId}</text>` +
    `<rect x='120' y='150' width='1360' height='620' rx='14' fill='hsl(${hue},22%,15%)' stroke='hsl(${hue},40%,30%)' stroke-width='2'/>` +
    `<text x='160' y='230' fill='#9fb3ad' font-family='monospace' font-size='30'>Recall keyframe (mock preview)</text>` +
    `<text x='160' y='290' fill='#6b7d78' font-family='monospace' font-size='22'>1600 &#215; 900 &#183; monitor 0</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
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
