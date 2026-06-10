export interface AgentConfig {
  server_url: string;
  agent_name: string;
  agent_token: string;
  install_id: string;
  ui_password_hash: string;
  auto_update_enabled: boolean;
  tray_icon_enabled: boolean;
}

export type ConnectionStatus = "Connected" | "Connecting" | "Disconnected" | "Error";

export interface StatusResponse {
  status: ConnectionStatus;
  message?: string;
}

export interface ManualUpdateCheckResponse {
  update_available: boolean;
  published_version?: string;
  running_version: string;
}

export interface ManualApplyUpdateResponse {
  outcome: string;
}

export interface LogSourceDesc {
  id: string;
  label: string;
  path: string;
}

export interface DiscoveredServer {
  instanceName: string;
  wssUrl: string;
}

export type UpdateDialogState =
  | null
  | { phase: "checking" }
  | { phase: "uptodate" }
  | { phase: "available"; publishedVersion: string }
  | { phase: "error"; message: string }
  | { phase: "installing" };

export type NavId = "dashboard" | "connection" | "security" | "logs";
export type AppScreen = "loading" | "password" | "settings";
export type NoticeTone = "success" | "error" | "info";
