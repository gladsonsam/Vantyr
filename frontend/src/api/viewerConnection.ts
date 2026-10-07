import type { WsEvent, WsStatus } from "@/api/types";

export interface ViewerConnectionOptions {
  onMessage: (ev: WsEvent) => void;
  onStatusChange?: (s: WsStatus) => void;
  /** When false, no socket is opened (saves work until the user is logged in). */
  enabled?: boolean;
}

/**
 * Hook that connects the dashboard to the server's live event feed and returns the `send` for
 * viewer commands. The real one is {@link useWebSocket}; the demo build injects a simulated feed.
 */
export type ViewerConnection = (options: ViewerConnectionOptions) => { send: (data: unknown) => void };
