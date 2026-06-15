// ── Domain models ─────────────────────────────────────────────────────────────

export interface Agent {
  id: string;
  name: string;
  first_seen: string;
  last_seen: string;
  /** Optional emoji / short label assigned by operator. */
  icon?: string | null;
  /** Latest stored agent version (from `agent_info`), if available. */
  agent_version?: string | null;
  online: boolean;
  connected_at: string | null;       // null when offline
  last_connected_at: string | null;
  last_disconnected_at: string | null;
}

/** Live status tracked from WebSocket events per agent. */
export interface AgentLiveStatus {
  window?: string; // last focused window title
  app?: string; // last focused app exe name
  url?: string; // last active browser URL
  activity?: "afk" | "active";
  /** Raw idle seconds reported by the agent at last AFK update. */
  idleSecs?: number;
  /**
   * Client-side timestamp used to compute a continuously increasing idle duration.
   * When present, effective idle seconds is `floor((nowMs - idleSinceMs) / 1000)`.
   */
  idleSinceMs?: number;
}

export interface WindowEvent {
  title: string;
  app: string;
  app_display?: string;
  hwnd: number;
  ts: string;
  created: string;
  /** Best-effort logged-in user at time of event (e.g. `DOMAIN\\user`). */
  user?: string | null;
}

export interface KeySession {
  app: string;
  app_display?: string;
  window_title: string;
  text: string;
  started_at: string;
  updated_at: string;
  user?: string | null;
}

export interface UrlVisit {
  id?: number;
  url: string;
  title?: string | null;
  browser: string;
  ts: string;
  /** Best-effort logged-in user at time of event (e.g. `DOMAIN\\user`). */
  user?: string | null;
  category_key?: string | null;
  category?: string | null;
}

export interface ActivityEvent {
  kind: "afk" | "active";
  idle_secs?: number;
  ts: string;
  user?: string | null;
}

/** One row from installed-software inventory (Windows Uninstall registry). */
export interface AgentSoftwareRow {
  name: string;
  version?: string | null;
  publisher?: string | null;
  install_location?: string | null;
  install_date?: string | null;
  captured_at: string;
}

export interface NetworkAdapterInfo {
  name?: string;
  description?: string;
  mac?: string;
  ips?: string[];
  gateways?: string[];
  dns?: string[];
}

export interface DriveInfo {
  name?: string;
  mount_point?: string;
  file_system?: string;
  total_gb?: number;
  available_gb?: number;
}

export interface AgentInfo {
  agent_version?: string;
  hostname?: string;
  uptime_secs?: number;
  system_model?: string;
  system_manufacturer?: string;
  system_serial?: string;
  motherboard_model?: string;
  motherboard_manufacturer?: string;
  os_name?: string;
  os_version?: string | null;
  os_long_version?: string | null;
  kernel_version?: string | null;
  cpu_brand?: string;
  cpu_cores?: number;
  memory_total_mb?: number;
  memory_used_mb?: number;
  adapters?: NetworkAdapterInfo[];
  drives?: DriveInfo[];
  // Extra environment / install metadata (optional, for Specs tab only).
  config_path?: string;
  install_path?: string | null;
  config_server_url?: string;
  config_agent_name?: string;
  config_ui_password_set?: boolean;
  current_user?: string;
  ts?: number;
}

// ── WebSocket event envelope ──────────────────────────────────────────────────
//
// The WS viewer sends `event` for its own envelopes (init).
// Agent broadcasts use `type`, which is normalised to `event` by useWebSocket.

export type WsEvent =
  | { event: "init"; agents: Agent[] }
  | { event: "agent_connected"; agent_id: string; name: string; connected_at: string }
  | { event: "agent_disconnected"; agent_id: string; disconnected_at?: string }
  | { event: "window_focus"; agent_id: string; title?: string; app?: string }
  | { event: "agent_info"; agent_id: string; data?: AgentInfo }
  | {
      event: "keys";
      agent_id: string;
      app?: string;
      window_title?: string;
      text?: string;
    }
  | { event: "url"; agent_id: string; url?: string; browser?: string }
  | { event: "afk"; agent_id: string; idle_secs?: number }
  | { event: "active"; agent_id: string }
  | {
      event: "dir_list";
      agent_id: string;
      data: {
        path: string;
        items: { name: string; is_dir: boolean; size: number }[];
      };
    }
  | {
      event: "file_chunk";
      agent_id: string;
      data: { path: string; data: string; chunk_index: number; total_chunks: number; is_error: boolean };
    }
  | {
      event: "file_upload_result";
      agent_id: string;
      data: { path: string; ok: boolean; error?: string };
    }
  | {
      event: "alert_rule_match";
      agent_id?: string;
      agent_name?: string;
      rule_id?: number;
      rule_name?: string;
      snippet?: string;
    };

/**
 * Server-side telemetry retention.
 * Global defaults: `null` = unlimited (UI shows 0).
 * Agent override body/response: `null` = inherit global for that field; `0` = unlimited override.
 */
export interface RetentionPolicy {
  keylog_days: number | null;
  window_days: number | null;
  url_days: number | null;
}

// ── Resource health history (CPU/mem/disk over time) ─────────────────────────

export interface AgentMetricPoint {
  /** Bucket start, epoch seconds. */
  t: number;
  cpu_pct: number;
  mem_pct: number;
  mem_used_mb: number;
  mem_total_mb: number;
  disk_pct: number;
  disk_used_gb: number;
  disk_total_gb: number;
}

export interface AgentMetricsResponse {
  from: string;
  to: string;
  bucket_secs: number;
  points: AgentMetricPoint[];
}

export interface UrlTopRow {
  url: string;
  visit_count: number;
  last_ts: string;
}

export interface WindowTopRow {
  app: string;
  app_display?: string;
  title: string;
  focus_count: number;
  last_ts: string;
}

export interface StorageTableUsage {
  name: string;
  bytes: number;
}

export interface StorageUsage {
  /** `pg_database_size(current database)` — full on-disk size for this DB (tables, indexes, TOAST, etc.). */
  database_bytes: number;
  /** Sum of `pg_total_relation_size` for listed `public` relations (see server; excludes partition children). */
  public_tables_bytes: number;
  /** Remainder: system catalogs (`pg_catalog`, etc.), internal structures not tied to a `public` rel. */
  other_bytes: number;
  tables: StorageTableUsage[];
}

/** Windows agent “Vantyr settings” window lock; hash is server-side only. */
export interface LocalUiPasswordGlobalState {
  password_set: boolean;
}

export interface LocalUiPasswordAgentState {
  global: { password_set: boolean };
  /** `null` = this agent follows the global default (no per-PC row). */
  override: { password_set: boolean } | null;
}

// ── Dashboard users (admin) ───────────────────────────────────────────────────

export type DashboardRole = "admin" | "operator" | "viewer";

/** Human-readable role for UI (nav, labels). */
export function dashboardRoleLabel(role: DashboardRole): string {
  switch (role) {
    case "admin":
      return "Administrator";
    case "operator":
      return "Operator";
    case "viewer":
      return "Viewer";
  }
}

/** Session user from `GET /api/me` (includes CSRF for mutating API calls). */
export interface DashboardSessionUser {
  id: string;
  username: string;
  /** Optional full name shown in the UI; sign-in uses `username`. */
  display_name?: string;
  role: DashboardRole;
  /** Lucide key (`icon:lucide:Name`) or small JPEG/PNG/WebP/GIF data URL. */
  display_icon?: string | null;
  csrf_token?: string;
}

/** Subset passed into the shell / top navigation. */
export type DashboardNavUser = Pick<DashboardSessionUser, "username" | "display_name" | "role" | "display_icon">;

export interface DashboardUser {
  id: string;
  username: string;
  display_name?: string;
  role: DashboardRole;
  /** Lucide icon key or photo data URL; initials when unset. */
  display_icon?: string | null;
  created_at: string;
}

export interface DashboardIdentity {
  id: number;
  issuer: string;
  subject: string;
  preferred_username?: string | null;
  email?: string | null;
  name?: string | null;
  last_login_at: string;
  created_at: string;
}

// ── Alert rules & agent groups (admin) ───────────────────────────────────────

export interface AgentGroup {
  id: string;
  name: string;
  description: string;
  created_at: string;
  member_count: number;
}

/** Subset returned for one agent’s group memberships (no counts or timestamps). */
export interface AgentGroupMembership {
  id: string;
  name: string;
  description: string;
}

export type AlertRuleScopeKind = "all" | "group" | "agent";

export interface AlertRuleScope {
  kind: AlertRuleScopeKind;
  group_id?: string;
  agent_id?: string;
}

export type AlertRuleChannel = "url" | "keys" | "url_category" | "agent_offline" | "resource";
export type AlertRuleMatchMode = "substring" | "regex";
/** Monitoring (`resource`) metric. */
export type AlertRuleMetric = "cpu_pct" | "mem_pct" | "disk_pct";
/** Monitoring (`resource`) comparator: greater-than / less-than. */
export type AlertRuleComparator = "gt" | "lt";

export interface AlertRule {
  id: number;
  name: string;
  channel: AlertRuleChannel;
  pattern: string;
  match_mode: AlertRuleMatchMode;
  case_insensitive: boolean;
  cooldown_secs: number;
  enabled: boolean;
  take_screenshot?: boolean;
  // Monitoring channels only.
  metric?: AlertRuleMetric | null;
  comparator?: AlertRuleComparator | null;
  threshold?: number | null;
  duration_secs?: number | null;
  scopes: AlertRuleScope[];
}

// ── Effective rules (per-agent) ───────────────────────────────────────────────

/** Minimal alert rule row returned by the effective-rules endpoint. */
export interface AlertRuleRow {
  id: number;
  name: string;
  pattern: string;
  match_mode: string;
  case_insensitive: boolean;
  cooldown_secs: number;
  take_screenshot: boolean;
  scope_kind?: string;
}

// ── App block events ──────────────────────────────────────────────────────────

export interface AppBlockEvent {
  id: number;
  agent_id: string;
  agent_name: string;
  rule_id: number | null;
  rule_name: string | null;
  exe_name: string;
  killed_at: string;
}

// ── Internet block rules ──────────────────────────────────────────────────────

export interface RuleSchedule {
  /** Sunday=0 .. Saturday=6 (agent-local time). */
  day_of_week: number;
  start_minute: number;
  end_minute: number;
}

export interface InternetBlockRuleScope {
  kind: "all" | "group" | "agent";
  group_id?: string;
  agent_id?: string;
}

export interface InternetBlockRule {
  id: number;
  name: string;
  enabled: boolean;
  created_at: string;
  scopes: InternetBlockRuleScope[];
  schedules: RuleSchedule[];
}

// ── App block rules ───────────────────────────────────────────────────────────

export type AppBlockMatchMode = "exact" | "contains";

export interface AppBlockRuleScope {
  kind: "all" | "group" | "agent";
  group_id?: string;
  agent_id?: string;
}

export interface AppBlockRule {
  id: number;
  name: string;
  exe_pattern: string;
  match_mode: AppBlockMatchMode;
  enabled: boolean;
  created_at?: string;
  /** Present when fetching effective rules for an agent (summary of most-permissive scope). */
  scope_kind?: "all" | "group" | "agent";
  /** Present when fetching the full rule list (includes all scope rows). */
  scopes?: AppBlockRuleScope[];
  schedules: RuleSchedule[];
}

// ── Scheduled Scripts ───────────────────────────────────────────────────────────

export interface ScheduledScriptScope {
  kind: "all" | "group" | "agent";
  group_id?: string;
  agent_id?: string;
}

export interface ScheduledScriptSchedule {
  frequency: "hourly" | "daily" | "weekly";
  day_of_week?: number | null;
  fire_minute: number;
}

export interface ScheduledScript {
  id: number;
  name: string;
  shell: string;
  script: string;
  timeout_secs: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  scopes: ScheduledScriptScope[];
  schedules: ScheduledScriptSchedule[];
}

export interface ScheduledScriptEvent {
  script_id: number;
  agent_id: string;
  agent_name: string;
  rule_name?: string; // Only for global feed
  status: string;
  expected_fire_time: string;
  output?: string;
  is_manual?: boolean;
}

export interface AgentSessionEvent {
  id: number;
  agent_id: string;
  agent_name: string;
  connected_at: string;
  disconnected_at: string | null;
}

// ── UI ────────────────────────────────────────────────────────────────────────

export type TabKey =
  | "live"
  | "activity"
  | "specs"
  | "software"
  | "scripts"
  | "logs"
  | "analytics"
  | "keys"
  | "windows"
  | "urls"
  | "alerts"
  | "files"
  | "control"
  | "settings";
