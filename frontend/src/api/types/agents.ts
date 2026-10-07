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

export interface MonitorInfo {
  /** 0-based index; pass this to the MJPEG stream to select the monitor. */
  index?: number;
  name?: string;
  width?: number;
  height?: number;
  primary?: boolean;
}

export interface AgentCapabilityInfo {
  platform?: string;
  session_type?: string;
  desktop?: string;
  screen_capture?: string;
  audio_capture?: string;
  remote_input?: string;
  clipboard?: string;
  keyboard_monitor?: string;
  url_tracking?: string;
  active_window?: string;
  software_inventory?: string;
  terminal?: string;
  script_execution?: string;
  app_blocking?: string;
  network_blocking?: string;
  system_control?: string;
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
  monitors?: MonitorInfo[];
  // Extra environment / install metadata (optional, for Specs tab only).
  config_path?: string;
  install_path?: string | null;
  config_server_url?: string;
  config_agent_name?: string;
  config_ui_password_set?: boolean;
  current_user?: string;
  capabilities?: AgentCapabilityInfo;
  ts?: number;
}

/** Sanitized stored enrichment; policy fields describe configuration, not enforcement. */
export interface FleetAgentSummary {
  info: AgentInfo | null;
  info_reported_at: string | null;
  last_window: { app: string; title: string; reported_at: string } | null;
  /** Applicable always-on rules only; scheduled/current enforcement is unknown. */
  internet_blocked: boolean;
  internet_block_source: "all" | "group" | "agent" | null;
  /** Enabled applicable rules, including scheduled rules, counted distinctly. */
  app_block_enabled_count: number;
}
export interface FleetSummaryResponse {
  agents: Record<string, FleetAgentSummary>;
  missing: string[];
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
