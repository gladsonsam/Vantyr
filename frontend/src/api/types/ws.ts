import type { Agent, AgentInfo } from "./agents";

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

// ── WebSocket event envelope ──────────────────────────────────────────────────
//
// The WS viewer sends `event` for its own envelopes (init).
// Agent broadcasts use `type`, which is normalised to `event` by useWebSocket.

export type WsEvent =
  | { event: "init"; agents: Agent[] }
  | { event: "agent_connected"; agent_id: string; name: string; connected_at: string }
  | { event: "agent_disconnected"; agent_id: string; disconnected_at?: string }
  | { event: "agent_removed"; agent_id: string }
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
      data?: {
        path?: string;
        items?: { name: string; is_dir: boolean; size: number }[];
      };
    }
  | {
      event: "file_chunk";
      agent_id: string;
      /** On `is_error`, `data` carries the agent's error text instead of base64 bytes. */
      data?: { path?: string; data?: string; chunk_index?: number; total_chunks?: number; is_error?: boolean };
    }
  | {
      event: "file_upload_result";
      agent_id: string;
      data?: { path?: string; ok?: boolean; error?: string };
    }
  | {
      event: "fs_op_result";
      agent_id: string;
      data?: { request_id?: string; ok?: boolean; error?: string; op?: string; src?: string; dst?: string; recursive?: boolean };
    }
  | {
      /** Reply to `control_acquire` / `control_heartbeat` / `control_release`, or a server-side revoke. */
      event: "control_lease";
      agent_id: string;
      request_id?: string;
      status?: "granted" | "denied" | "released" | "revoked";
      lease_token?: string;
      expires_in_ms?: number;
      error?: string;
    }
  | {
      /** The agent refused a command because its module (`remote_input`, `clipboard`, …) is off or unauthorized. */
      event: "command_rejected";
      agent_id: string;
      module?: string;
      error?: string;
    }
  | {
      event: "alert_rule_match";
      agent_id?: string;
      agent_name?: string;
      rule_id?: number;
      rule_name?: string;
      snippet?: string;
    };

export type WsEventType = WsEvent["event"];
export type WsEventOf<T extends WsEventType> = Extract<WsEvent, { event: T }>;

/** Viewer socket connection state. */
export type WsStatus = "connecting" | "connected" | "disconnected";
