import type { WsEvent, WsStatus } from "@/api/types";
import { buildViewerWsUrl } from "./serverSettings";

/** One explicitly owned socket/retry lifecycle; stop cancels every allocation. */
export function startViewerSocket(
  onMessage: (event: WsEvent) => void,
  reportStatus: (status: WsStatus) => void,
) {
  let disposed = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;
  // Only this lifecycle and its retry timer may create a replacement socket.
  const connect = () => {
    const ws = new WebSocket(buildViewerWsUrl());
    socket = ws;

    reportStatus("connecting");

    ws.onopen = () => {
      if (disposed || socket !== ws) return;
      reportStatus("connected");
      retryAttempt = 0;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    ws.onmessage = (e: MessageEvent<string>) => {
      if (disposed || socket !== ws) return;
      try {
        const raw = JSON.parse(e.data) as Record<string, unknown>;
        if (!raw.event && raw.type) raw.event = raw.type;
        onMessage(raw as WsEvent);
      } catch {
        /* ignore malformed */
      }
    };

    ws.onclose = () => {
      if (socket !== ws) return;
      reportStatus("disconnected");
      if (disposed || socket !== ws) {
        return;
      }
      const attempt = retryAttempt++;
      const baseMs = 750;
      const maxMs = 30_000;
      const exp = Math.min(6, attempt);
      const delay = Math.min(maxMs, baseMs * Math.pow(2, exp));
      const jitter = Math.floor(Math.random() * 500);
      retryTimer = setTimeout(() => {
        if (!disposed) connect();
      }, delay + jitter);
    };

    ws.onerror = () => ws.close();
  };
  connect();
  const stop = () => {
    disposed = true;
    reportStatus("disconnected");
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    const activeSocket = socket;
    socket = null;
    activeSocket?.close();
  };
  return {
    stop,
    send: (data: unknown) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
    },
  };
}
