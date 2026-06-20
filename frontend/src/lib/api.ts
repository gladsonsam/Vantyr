import type {
  Agent,
  WindowEvent,
  KeySession,
  UrlVisit,
  ActivityEvent,
  AgentInfo,
  AgentMetricsResponse,
  AgentSoftwareRow,
  RetentionPolicy,
  StorageUsage,
  UrlTopRow,
  WindowTopRow,
  LocalUiPasswordGlobalState,
  LocalUiPasswordAgentState,
  DashboardUser,
  DashboardSessionUser,
  DashboardIdentity,
  DashboardRole,
  AgentGroup,
  AgentGroupMembership,
  AlertRule,
  AlertRuleRow,
  AppBlockRule,
  AppBlockEvent,
  InternetBlockRule,
  ScheduledScript,
  ScheduledScriptScope,
  ScheduledScriptSchedule,
  ScheduledScriptEvent,
  AgentSessionEvent,
} from "./types";
import { buildApiUrl } from "./serverSettings";
import { publishServerVersion, type SettingsVersionPayload } from "./serverVersionStore";
import { createDemoApi } from "../demo/api";
import { isDemoMode } from "../demo/mode";

interface PageParams {
  limit?: number;
  offset?: number;
}

export class ApiError extends Error {
  status: number;
  payload?: unknown;

  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/**
 * Human-readable message for any caught value. Prefers the `ApiError`/`Error` message over
 * `String(e)` (which yields noisy `"Error: …"` / `"[object Object]"` text in the UI).
 */
export function errorText(e: unknown): string {
  if (isApiError(e)) return e.message;
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

/** `?limit=&offset=` query suffix for list endpoints (omit empty). */
function limitOffsetQuery(params?: { limit?: number; offset?: number }): string {
  const q = new URLSearchParams();
  if (params?.limit != null) q.set("limit", String(params.limit));
  if (params?.offset != null) q.set("offset", String(params.offset));
  const qs = q.toString();
  return qs ? `?${qs}` : "";
}

/** Paths are relative to `apiPrefix` (e.g. `/agents`, `/settings/retention`), not including `/api` twice. */
export function apiUrl(path: string): string {
  return buildApiUrl(path);
}

/** Per-tab CSRF token (`sessionStorage` isolates concurrent logins across browser tabs). */
const CSRF_STORAGE_KEY = "vantyr.dashboard.csrf";

export function setDashboardCsrfToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(CSRF_STORAGE_KEY, token);
    else sessionStorage.removeItem(CSRF_STORAGE_KEY);
  } catch {
    // Storage disabled — CSRF-protected mutating calls may fail until login succeeds again.
  }
}

function csrfHeaders(): Record<string, string> {
  try {
    const t = sessionStorage.getItem(CSRF_STORAGE_KEY);
    if (!t) return {};
    return { "X-CSRF-Token": t };
  } catch {
    return {};
  }
}

export type MjpegStreamTuning = {
  jpegQ: number;
  intervalMs: number;
};

/** Multipart MJPEG URL; `session` must match {@link notifyMjpegViewerLeft}. */
export function mjpegStreamUrl(agentId: string, session: string, tuning?: MjpegStreamTuning): string {
  if (isDemoMode) {
    const label = encodeURIComponent(`Vantyr demo stream - ${agentId}`);
    return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1280 720'%3E%3Crect width='1280' height='720' fill='%230b0c0f'/%3E%3Cpath d='M0 80h1280M0 160h1280M0 240h1280M0 320h1280M0 400h1280M0 480h1280M0 560h1280M0 640h1280M160 0v720M320 0v720M480 0v720M640 0v720M800 0v720M960 0v720M1120 0v720' stroke='%2322262e' stroke-width='2'/%3E%3Crect x='390' y='255' width='500' height='210' rx='24' fill='%2315171c' stroke='%233b82f6' stroke-opacity='.45'/%3E%3Ctext x='640' y='345' text-anchor='middle' fill='%23eceef1' font-family='Segoe UI, sans-serif' font-size='36' font-weight='700'%3EVantyr demo stream%3C/text%3E%3Ctext x='640' y='395' text-anchor='middle' fill='%23a4a8b2' font-family='Consolas, monospace' font-size='22'%3E${label}%3C/text%3E%3C/svg%3E`;
  }
  const qs = new URLSearchParams();
  qs.set("session", session);
  if (tuning) {
    qs.set("jpeg_q", String(tuning.jpegQ));
    qs.set("interval_ms", String(tuning.intervalMs));
  }
  return apiUrl(`/agents/${agentId}/mjpeg?${qs.toString()}`);
}

/** Tell the server this dashboard tab stopped viewing live screen (sends `stop_capture` when last viewer). */
export function notifyMjpegViewerLeft(agentId: string, session: string): void {
  if (isDemoMode) return;
  if (!session) return;
  void fetch(apiUrl(`/agents/${agentId}/mjpeg/leave`), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeaders() },
    body: JSON.stringify({ session }),
    credentials: "include",
    keepalive: true,
  }).catch(() => {
    /* best-effort */
  });
}

async function get<T>(path: string): Promise<T> {
  return requestJson<T>(path, { method: "GET" }, { includePathInHttpError: true });
}

async function requestJson<T>(
  path: string,
  init: RequestInit,
  opts?: { includePathInHttpError?: boolean; allowStatuses?: number[] },
): Promise<T> {
  const res = await fetch(apiUrl(path), { ...init, credentials: "include" });
  const ct = res.headers.get("Content-Type") ?? "";

  // Prefer structured errors when possible.
  const allowed = opts?.allowStatuses?.includes(res.status) ?? false;
  if (!res.ok && !allowed) {
    // Global session-expiry recovery: a 401 from any authenticated request means
    // the cookie session is gone. Notify the app so it can demote to signed-out.
    // (Login submits its own 401s, which the app handles inline — skip those.)
    if (res.status === 401 && path !== "/login") {
      setDashboardCsrfToken(null);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("vantyr-session-expired"));
      }
    }
    if (ct.includes("application/json")) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const suffix = opts?.includePathInHttpError ? ` – ${path}` : "";
      throw new ApiError(body.error ?? `HTTP ${res.status}${suffix}`, res.status, body);
    }
    const text = await res.text().catch(() => "");
    const suffix = opts?.includePathInHttpError ? ` – ${path}` : "";
    throw new ApiError(text.trim() || `HTTP ${res.status}${suffix}`, res.status);
  }

  if (!ct.includes("application/json")) {
    const text = await res.text().catch(() => "");
    throw new Error(`Expected JSON from ${path}; got ${ct || "unknown type"}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function putJson<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...csrfHeaders() },
    body: JSON.stringify(body),
  });
}

async function postEmpty<T>(path: string): Promise<T> {
  return requestJson<T>(path, {
    method: "POST",
    headers: { ...csrfHeaders() },
  });
}

async function postJsonRes<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeaders() },
    body: JSON.stringify(body),
  });
}

async function delJson<T>(path: string): Promise<T> {
  return requestJson<T>(path, {
    method: "DELETE",
    headers: { ...csrfHeaders() },
  });
}

export const realApi = {
  // ── Auth ──────────────────────────────────────────────────────────────────

  /** Check whether the current session is valid (or no password is set). */
  authStatus: async (): Promise<{
    authenticated: boolean;
    password_required: boolean;
  }> => {
    return requestJson(
      "/auth/status",
      { method: "GET" },
      { allowStatuses: [401] },
    );
  },

  authConfig: (): Promise<{ oidc_enabled: boolean }> =>
    get("/auth/config"),

  /** Submit credentials; throws with the server error message on failure.
   *  When the account has 2FA, the first call throws a 401 with `totp_required`;
   *  retry with `totpCode` (a 6-digit TOTP or a recovery code). */
  login: async (username: string, password: string, totpCode?: string): Promise<void> => {
    const data = await requestJson<{ csrf_token?: string }>(
      "/login",
      {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, totp_code: totpCode }),
      },
    );
    if (typeof data.csrf_token === "string" && data.csrf_token.length > 0) {
      setDashboardCsrfToken(data.csrf_token);
    }
  },

  // ── Two-factor auth (TOTP) ─────────────────────────────────────────────────
  twofaStatus: (): Promise<{ enabled: boolean; pending: boolean }> => get("/2fa/status"),
  twofaSetup: (): Promise<{ secret: string; otpauth_uri: string }> =>
    postEmpty("/2fa/setup"),
  twofaEnable: (code: string): Promise<{ ok: boolean; recovery_codes: string[] }> =>
    postJsonRes("/2fa/enable", { code }),
  twofaDisable: (code: string): Promise<{ ok: boolean }> =>
    postJsonRes("/2fa/disable", { code }),

  /** Clear the current session cookie. */
  logout: async (): Promise<void> => {
    await requestJson("/logout", { method: "POST" }).catch(() => {
      /* ignore */
    });
    setDashboardCsrfToken(null);
  },

  me: (): Promise<DashboardSessionUser> => get("/me"),

  // ── Dashboard data ────────────────────────────────────────────────────────

  /** Agent directory with live `online` + session timestamps (use for all dashboard lists). */
  agentsOverview: (): Promise<{ agents: Agent[] }> => get("/agents/overview"),

  // ── Agent UI metadata ─────────────────────────────────────────────────────

  agentIconGet: (id: string): Promise<{ icon: string | null }> =>
    get(`/agents/${id}/icon`),

  agentIconPut: (id: string, icon: string | null): Promise<{ icon: string | null }> =>
    putJson(`/agents/${id}/icon`, { icon }),

  /** Admin: groups this agent belongs to. */
  agentGroupsForAgent: (id: string): Promise<{ groups: AgentGroupMembership[] }> =>
    get(`/agents/${id}/groups`),

  windows: (
    id: string,
    { limit = 100, offset = 0 }: PageParams = {},
  ): Promise<{ rows: WindowEvent[] }> =>
    get(`/agents/${id}/windows?limit=${limit}&offset=${offset}`),

  keys: (
    id: string,
    { limit = 100, offset = 0 }: PageParams = {},
  ): Promise<{ rows: KeySession[] }> =>
    get(`/agents/${id}/keys?limit=${limit}&offset=${offset}`),

  urls: (
    id: string,
    { limit = 100, offset = 0 }: PageParams = {},
  ): Promise<{ rows: UrlVisit[] }> =>
    get(`/agents/${id}/urls?limit=${limit}&offset=${offset}`),

  activity: (
    id: string,
    { limit = 100, offset = 0 }: PageParams = {},
  ): Promise<{ rows: ActivityEvent[] }> =>
    get(`/agents/${id}/activity?limit=${limit}&offset=${offset}`),

  agentInfo: (id: string): Promise<{ info: AgentInfo | null }> =>
    get(`/agents/${id}/info`),

  /** Resource health history (CPU/mem/disk) for an agent over a time range. */
  agentMetrics: (
    id: string,
    fromIso?: string,
    toIso?: string,
  ): Promise<AgentMetricsResponse> => {
    const params = new URLSearchParams();
    if (fromIso) params.set("from", fromIso);
    if (toIso) params.set("to", toIso);
    const qs = params.toString();
    return get(`/agents/${id}/metrics${qs ? `?${qs}` : ""}`);
  },

  topUrls: (
    id: string,
    { limit = 100, offset = 0 }: PageParams = {},
  ): Promise<{ rows: UrlTopRow[] }> =>
    get(`/agents/${id}/top-urls?limit=${limit}&offset=${offset}`),

  topWindows: (
    id: string,
    { limit = 100, offset = 0 }: PageParams = {},
  ): Promise<{ rows: WindowTopRow[] }> =>
    get(`/agents/${id}/top-windows?limit=${limit}&offset=${offset}`),

  // ── Destructive actions ────────────────────────────────────────────────
  /** Clear all stored telemetry history for this agent (windows/keys/urls/activity). */
  clearAgentHistory: (id: string): Promise<{ cleared_rows: number }> =>
    postEmpty(`/agents/${id}/history/clear`),

  // ── Retention (server) ───────────────────────────────────────────────────

  retentionGlobalGet: (): Promise<RetentionPolicy> => get("/settings/retention"),

  retentionGlobalPut: (body: RetentionPolicy): Promise<RetentionPolicy> =>
    putJson("/settings/retention", body),

  retentionAgentGet: (
    id: string,
  ): Promise<{ global: RetentionPolicy; override: RetentionPolicy | null }> =>
    get(`/agents/${id}/retention`),

  retentionAgentPut: (
    id: string,
    body: RetentionPolicy,
  ): Promise<{ global: RetentionPolicy; override: RetentionPolicy | null }> =>
    putJson(`/agents/${id}/retention`, body),

  retentionAgentDelete: (
    id: string,
  ): Promise<{ global: RetentionPolicy; override: RetentionPolicy | null }> =>
    delJson(`/agents/${id}/retention`),

  /** Wake-on-LAN using MAC from last stored system info (`POST`, optional `broadcast`, `port`). */
  wakeAgent: async (
    id: string,
    opts?: { broadcast?: string; port?: number },
  ): Promise<{ ok: boolean; mac: string; broadcast: string; port: number }> => {
    const p = new URLSearchParams();
    if (opts?.broadcast) p.set("broadcast", opts.broadcast);
    if (opts?.port != null) p.set("port", String(opts.port));
    const qs = p.toString();
    const body = await requestJson<{
      ok?: boolean;
      mac?: string;
      broadcast?: string;
      port?: number;
      retry_after_secs?: number;
    }>(`/agents/${id}/wake${qs ? `?${qs}` : ""}`, {
      method: "POST",
      headers: { ...csrfHeaders() },
    });
    return {
      ok: body.ok ?? true,
      mac: body.mac ?? "",
      broadcast: body.broadcast ?? "",
      port: body.port ?? 9,
    };
  },

  // ── Agent local settings window password (pushed to Windows agents) ───────

  localUiPasswordGlobalGet: (): Promise<LocalUiPasswordGlobalState> =>
    get("/settings/local-ui-password"),

  localUiPasswordGlobalPut: (body: {
    password: string | null;
  }): Promise<LocalUiPasswordGlobalState> =>
    putJson("/settings/local-ui-password", body),

  localUiPasswordAgentGet: (
    id: string,
  ): Promise<LocalUiPasswordAgentState> =>
    get(`/agents/${id}/local-ui-password`),

  localUiPasswordAgentPut: (
    id: string,
    body: { password: string | null },
  ): Promise<LocalUiPasswordAgentState> =>
    putJson(`/agents/${id}/local-ui-password`, body),

  localUiPasswordAgentDelete: (
    id: string,
  ): Promise<LocalUiPasswordAgentState> =>
    delJson(`/agents/${id}/local-ui-password`),

  // ── Agent auto-update policy (pushed to Windows agents) ────────────────────

  agentAutoUpdateGlobalGet: (): Promise<{ enabled: boolean }> =>
    get("/settings/agent-auto-update"),

  agentAutoUpdateGlobalPut: (body: { enabled: boolean }): Promise<{ enabled: boolean }> =>
    putJson("/settings/agent-auto-update", body),

  agentAutoUpdateAgentGet: (
    id: string,
  ): Promise<{ global: { enabled: boolean }; override: { enabled: boolean } | null }> =>
    get(`/agents/${id}/auto-update`),

  agentAutoUpdateAgentPut: (
    id: string,
    body: { enabled: boolean },
  ): Promise<{ global: { enabled: boolean }; override: { enabled: boolean } | null }> =>
    putJson(`/agents/${id}/auto-update`, body),

  agentAutoUpdateAgentDelete: (
    id: string,
  ): Promise<{ global: { enabled: boolean }; override: { enabled: boolean } | null }> =>
    delJson(`/agents/${id}/auto-update`),

  agentUpdateNow: (id: string): Promise<{ ok: boolean }> =>
    postEmpty(`/agents/${id}/update-now`),

  // ── URL categorization (UT1) ───────────────────────────────────────────────

  urlCategorizationStatusGet: (): Promise<{
    settings: {
      enabled: boolean;
      auto_update: boolean;
      source_url: string;
      last_update_at: string | null;
      last_update_error: string | null;
    };
    active_release: { sha256: string | null };
    counts: { categories: number; domains: number; urls: number };
    job?: {
      state: "idle" | "downloading" | "importing" | "ready" | "error";
      started_at: string | null;
      updated_at: string;
      bytes_total: number | null;
      bytes_done: number;
      message: string | null;
    } | null;
  }> => get("/settings/url-categorization"),

  urlCategorizationSettingsPut: (body: {
    enabled: boolean;
    auto_update: boolean;
    source_url: string;
  }): Promise<unknown> => putJson("/settings/url-categorization", body),

  urlCategorizationUpdateNow: (): Promise<unknown> =>
    postEmpty("/settings/url-categorization/update-now"),

  urlCategorizationCategoriesGet: (): Promise<{
    categories: { key: string; label?: string; enabled: boolean; description: string }[];
  }> => get("/settings/url-categorization/categories"),

  urlCategorizationCategoriesPut: (body: {
    categories: { key: string; enabled: boolean; label?: string; description?: string }[];
  }): Promise<{ categories: { key: string; label: string; enabled: boolean; description: string }[] }> =>
    putJson("/settings/url-categorization/categories", body),

  urlCategorizationOverridesList: (
    { q = "", limit = 200, offset = 0 }: { q?: string; limit?: number; offset?: number } = {},
  ): Promise<{ rows: { id: number; kind: "domain" | "url"; value: string; category_key: string; category_label: string; note: string; created_at: string }[] }> =>
    get(`/settings/url-categorization/overrides?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`),

  urlCategorizationOverridesUpsert: (body: { kind: "domain" | "url"; value: string; category_key: string; note?: string }): Promise<unknown> =>
    postJsonRes("/settings/url-categorization/overrides", body),

  urlCategorizationOverridesDelete: (kind: "domain" | "url", id: number): Promise<unknown> =>
    delJson(`/settings/url-categorization/overrides?kind=${encodeURIComponent(kind)}&id=${id}`),

  urlCategorizationRecalcUrlVisits: ({ limit = 50_000 }: { limit?: number } = {}): Promise<{ enqueued: number }> =>
    postEmpty(`/settings/url-categorization/recalc/url-visits?limit=${limit}`),

  urlCategorizationRecalcUrlSessions: ({ limit = 50_000 }: { limit?: number } = {}): Promise<{ updated: number }> =>
    postEmpty(`/settings/url-categorization/recalc/url-sessions?limit=${limit}`),

  agentUrlCategoryStats: (
    id: string,
    { limit = 24 }: { limit?: number } = {},
  ): Promise<{ rows: { category: string; visit_count: number; last_ts: string }[] }> =>
    get(`/agents/${id}/url-category-stats?limit=${limit}`),

  agentUrlCategoryBackfill: (
    id: string,
    { limit = 25_000 }: { limit?: number } = {},
  ): Promise<{ enqueued: number }> =>
    postEmpty(`/agents/${id}/url-category-backfill?limit=${limit}`),

  // ── Agent analytics (URL sessions) ───────────────────────────────────────

  agentAnalyticsUrlCategories: (
    id: string,
    { from, to, limit = 50 }: { from: string; to: string; limit?: number },
  ): Promise<{ rows: { category_key: string; category_label: string; time_ms: number; visit_count: number; last_ts: string }[] }> =>
    get(`/agents/${id}/analytics/url-categories?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=${limit}`),

  agentAnalyticsUrlSites: (
    id: string,
    {
      from,
      to,
      limit = 50,
      custom_category_key,
      category_key,
    }: { from: string; to: string; limit?: number; custom_category_key?: string; category_key?: string },
  ): Promise<{ rows: { hostname: string; category_key: string | null; category_label: string | null; time_ms: number; visit_count: number; last_ts: string }[] }> => {
    const custom = custom_category_key ? `&custom_category_key=${encodeURIComponent(custom_category_key)}` : "";
    const ut1 = category_key ? `&category_key=${encodeURIComponent(category_key)}` : "";
    return get(`/agents/${id}/analytics/url-sites?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=${limit}${custom}${ut1}`);
  },

  // ── Custom categories (admin rollups on top of UT1) ───────────────────────

  urlCustomCategoriesList: (): Promise<{
    rows: {
      id: number;
      key: string;
      label_en: string;
      description_en: string;
      display_order: number;
      hidden: boolean;
      updated_at: string;
      member_count: number;
      ut1_keys: string[];
    }[];
  }> => get("/settings/url-categorization/custom-categories"),

  urlCustomCategoriesCreate: (body: {
    key: string;
    label_en: string;
    description_en?: string;
    display_order?: number;
    hidden?: boolean;
  }): Promise<{ id: number }> => postJsonRes("/settings/url-categorization/custom-categories", body),

  urlCustomCategoriesUpdate: (
    id: number,
    body: { label_en?: string; description_en?: string; display_order?: number; hidden?: boolean },
  ): Promise<{ ok: boolean }> => putJson(`/settings/url-categorization/custom-categories/${id}`, body),

  urlCustomCategoriesDelete: (id: number): Promise<{ ok: boolean }> =>
    delJson(`/settings/url-categorization/custom-categories/${id}`),

  urlCustomCategoriesPutMembers: (
    id: number,
    body: { ut1_keys: string[] },
  ): Promise<{ ok: boolean; count: number }> =>
    putJson(`/settings/url-categorization/custom-categories/${id}/members`, body),

  agentAnalyticsUrlSessions: (
    id: string,
    { from, to, limit = 200 }: { from: string; to: string; limit?: number },
  ): Promise<{ rows: { id: number; url: string; hostname: string; ts_start: string; ts_end: string; duration_ms: number; user?: string | null; category_key?: string | null; category_label?: string | null; browser?: string | null; title?: string | null }[] }> =>
    get(`/agents/${id}/analytics/url-sessions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=${limit}`),

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

  /** Admin: LAN mDNS mode and agent WSS URL for onboarding (mirrors server `mdns_broadcast` rules). */
  getAgentSetupHints: (): Promise<{
    mdns: "advertising" | "disabled_by_env" | "unavailable_no_wss_url";
    agent_wss_url: string | null;
    mdns_port: number;
  }> => get("/settings/agent-setup-hints"),

  /** Admin: create a 6-digit pairing code for Windows agent claims. */
  createAgentEnrollmentToken: (body: {
    uses?: number;
    expires_in_hours?: number | null;
    note?: string | null;
  }): Promise<{
    id: string;
    enrollment_token: string;
    uses: number;
    expires_at: string | null;
    note?: string | null;
  }> => postJsonRes("/settings/agent-enrollment-tokens", body),

  /** Admin: list enrollment tokens (metadata only; plaintext code is shown once at creation). */
  listAgentEnrollmentTokens: (): Promise<{
    tokens: {
      id: string;
      uses_remaining: number;
      created_at: string;
      expires_at: string | null;
      note: string | null;
      used_count: number;
      last_used_at: string | null;
    }[];
  }> => get("/settings/agent-enrollment-tokens"),

  /** Admin: revoke an enrollment token (sets uses_remaining = 0). */
  revokeAgentEnrollmentToken: (id: string): Promise<{ ok: boolean }> =>
    delJson(`/settings/agent-enrollment-tokens/${encodeURIComponent(id)}`),

  /** Admin: revoke all enrollment tokens. */
  revokeAllAgentEnrollmentTokens: (): Promise<{ ok: boolean; revoked: number }> =>
    postEmpty("/settings/agent-enrollment-tokens/revoke-all"),

  /** Admin: list recent uses of an enrollment token. */
  listAgentEnrollmentTokenUses: (id: string): Promise<{
    uses: { used_at: string; agent_name: string; agent_id: string | null }[];
  }> => get(`/settings/agent-enrollment-tokens/${encodeURIComponent(id)}/uses`),

  listAgentEnrollmentClaims: (): Promise<{
    claims: {
      id: string;
      invite_id: string | null;
      status: "pending" | "approved" | "rejected" | "expired";
      requested_name: string;
      hostname: string | null;
      os: string | null;
      agent_version: string | null;
      client_ip: string | null;
      discovered_server: string | null;
      created_at: string;
      approved_by: string | null;
      approved_at: string | null;
      rejected_by: string | null;
      rejected_at: string | null;
      agent_id: string | null;
      error: string | null;
    }[];
  }> => get("/settings/agent-enrollment-claims"),

  approveAgentEnrollmentClaim: (
    id: string,
    body: { agent_name?: string | null; group_id?: string | null },
  ): Promise<{ ok: boolean; agent_id: string }> =>
    postJsonRes(`/settings/agent-enrollment-claims/${encodeURIComponent(id)}/approve`, body),

  rejectAgentEnrollmentClaim: (
    id: string,
    body: { error?: string | null } = {},
  ): Promise<{ ok: boolean }> =>
    postJsonRes(`/settings/agent-enrollment-claims/${encodeURIComponent(id)}/reject`, body),

  /** Admin: reset an agent’s saved token so it can enroll again. */
  revokeAgentCredentials: (agentId: string): Promise<{ ok: boolean }> =>
    postEmpty(`/agents/${encodeURIComponent(agentId)}/revoke-credentials`),

  /** Admin: delete agents (forgets them). */
  deleteAgents: (agentIds: string[]): Promise<{ ok: boolean; deleted: number }> =>
    postJsonRes("/agents/delete", { agent_ids: agentIds }),

  settingsVersionGet: async (opts?: { nocache?: boolean }): Promise<SettingsVersionPayload> => {
    const qs = opts?.nocache ? "?nocache=true" : "";
    const result = await get<SettingsVersionPayload>(`/settings/version${qs}`);
    publishServerVersion(result);
    return result;
  },

  storageUsage: (): Promise<StorageUsage> => get("/settings/storage"),

  capabilities: (): Promise<{ remote_script: boolean; scheduler_timezone?: string }> =>
    get("/settings/capabilities"),

  agentSoftware: (
    id: string,
    params?: { limit?: number; offset?: number },
  ): Promise<{
    rows: AgentSoftwareRow[];
    last_captured_at: string | null;
    total?: number;
    limit?: number;
    offset?: number;
  }> => {
    const qs = new URLSearchParams();
    if (params?.limit != null) qs.set("limit", String(params.limit));
    if (params?.offset != null) qs.set("offset", String(params.offset));
    const q = qs.toString();
    return get(`/agents/${id}/software${q ? `?${q}` : ""}`);
  },

  collectAgentSoftware: (id: string): Promise<{ ok: boolean }> =>
    postEmpty(`/agents/${id}/software/collect`),

  runAgentScript: (
    id: string,
    body: { shell: string; script: string; timeout_secs?: number },
  ): Promise<Record<string, unknown>> => postJsonRes(`/agents/${id}/script`, body),

  agentLogSources: (
    id: string,
  ): Promise<{
    sources: { id: string; label: string; path: string }[];
  }> =>
    get(`/agents/${id}/logs/sources`).then((r: unknown) => {
      const sourcesRaw =
        r != null && typeof r === "object" && "sources" in r
          ? (r as { sources?: unknown }).sources
          : undefined;
      const sources = Array.isArray(sourcesRaw)
        ? sourcesRaw.map((s): { id: string; label: string; path: string } => {
            const obj = s != null && typeof s === "object" ? (s as Record<string, unknown>) : {};
            const id = String(obj.id ?? "");
            const label = String(obj.label ?? obj.id ?? "");
            const path = String(obj.path ?? "");
            return { id, label, path };
          })
        : [];
      return { sources };
    }),

  // ── Audit log ─────────────────────────────────────────────────────────────

  audit: (params?: { limit?: number; agent_id?: string; status?: string }): Promise<{ rows: Record<string, unknown>[] }> => {
    const q = new URLSearchParams();
    q.set("limit", String(params?.limit ?? 500));
    if (params?.agent_id) q.set("agent_id", params.agent_id);
    if (params?.status) q.set("status", params.status);
    return get(`/audit?${q.toString()}`);
  },

  agentLogTail: (
    id: string,
    params?: { kind?: string; maxKb?: number },
  ): Promise<{ kind: string; text: string }> => {
    const q = new URLSearchParams();
    if (params?.kind) q.set("kind", params.kind);
    if (params?.maxKb != null) q.set("max_kb", String(params.maxKb));
    const qs = q.toString();
    return get(`/agents/${id}/logs/tail${qs ? `?${qs}` : ""}`).then((r: unknown) => {
      const obj = r != null && typeof r === "object" ? (r as Record<string, unknown>) : {};
      return {
        kind: String(obj.kind ?? params?.kind ?? ""),
        text: String(obj.text ?? ""),
      };
    });
  },

  bulkAgentScript: (body: {
    agent_ids: string[];
    shell: string;
    script: string;
    timeout_secs?: number;
  }): Promise<{ results: Record<string, unknown>[] }> =>
    postJsonRes("/agents/bulk-script", body),

  // ── Admin: users / identities ─────────────────────────────────────────────

  usersList: (): Promise<{ users: DashboardUser[] }> => get("/users"),

  userCreate: (body: {
    username: string;
    password: string;
    role: DashboardRole;
    display_name?: string;
  }): Promise<{ id: string }> => postJsonRes("/users", body),

  userSetPassword: (id: string, password: string): Promise<{ ok: boolean }> =>
    postJsonRes(`/users/${id}/password`, { password }),

  userSetRole: (id: string, role: DashboardRole): Promise<{ ok: boolean }> =>
    postJsonRes(`/users/${id}/role`, { role }),

  userUpdateProfile: (
    id: string,
    body: { username?: string; display_name?: string; display_icon?: string | null },
  ): Promise<{
    ok: boolean;
    id: string;
    username: string;
    display_name: string;
    display_icon: string | null;
  }> => postJsonRes(`/users/${id}/profile`, body),

  userDelete: (id: string): Promise<{ ok: boolean }> =>
    postEmpty(`/users/${id}/delete`),

  userIdentities: (id: string): Promise<{ identities: DashboardIdentity[] }> =>
    get(`/users/${id}/identities`),

  userIdentityLink: (
    id: string,
    body: { issuer: string; subject: string },
  ): Promise<{ ok: boolean }> => postJsonRes(`/users/${id}/identities/link`, body),

  identityUnlink: (identityId: number): Promise<{ ok: boolean }> =>
    postEmpty(`/identities/${identityId}/unlink`),

  // ── Admin: agent groups & alert rules (URL / keystroke notifications) ───────

  agentGroupsList: (): Promise<{ groups: AgentGroup[] }> => get("/agent-groups"),

  agentGroupsCreate: (body: {
    name: string;
    description?: string;
  }): Promise<{ id: string }> => postJsonRes("/agent-groups", body),

  agentGroupsUpdate: (
    id: string,
    body: { name: string; description?: string },
  ): Promise<{ ok: boolean }> => putJson(`/agent-groups/${id}`, body),

  agentGroupsDelete: (id: string): Promise<{ ok: boolean }> =>
    delJson(`/agent-groups/${id}`),

  agentGroupMembers: (groupId: string): Promise<{ agent_ids: string[] }> =>
    get(`/agent-groups/${groupId}/members`),

  agentGroupMembersAdd: (
    groupId: string,
    body: { agent_ids: string[] },
  ): Promise<{ added: number }> =>
    postJsonRes(`/agent-groups/${groupId}/members`, body),

  agentGroupMemberRemove: (
    groupId: string,
    agentId: string,
  ): Promise<{ ok: boolean }> =>
    delJson(`/agent-groups/${groupId}/members/${agentId}`),

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

  agentSessionsAll: (
    params?: { limit?: number },
  ): Promise<{ rows: AgentSessionEvent[] }> =>
    get(`/agent-sessions${limitOffsetQuery(params)}`),

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

export type ApiClient = typeof realApi;

export const api: ApiClient = isDemoMode ? createDemoApi(realApi) : realApi;

/** How often the UI should call `settingsVersionGet` (server caches GitHub for a similar window). */
export const SETTINGS_VERSION_POLL_INTERVAL_MS = 5 * 60 * 1000;
