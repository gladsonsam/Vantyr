import { useEffect, useRef, useCallback } from "react";
import type { WsEvent } from "../lib/types";
import { buildViewerWsUrl } from "../lib/serverSettings";

export type WsStatus = "connecting" | "connected" | "disconnected";

interface Options {
  onMessage: (ev: WsEvent) => void;
  onStatusChange: (s: WsStatus) => void;
  /** When false, no socket is opened (saves work until the user is logged in). */
  enabled?: boolean;
}

export function useWebSocket({ onMessage, onStatusChange, enabled = true }: Options) {
  const wsRef = useRef<WebSocket | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptRef = useRef(0);
  const disposedRef = useRef(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const msgCbRef = useRef(onMessage);
  const statusCbRef = useRef(onStatusChange);
  msgCbRef.current = onMessage;
  statusCbRef.current = onStatusChange;

  const connect = useCallback(() => {
    const ws = new WebSocket(buildViewerWsUrl());
    wsRef.current = ws;

    statusCbRef.current("connecting");

    ws.onopen = () => {
      statusCbRef.current("connected");
      retryAttemptRef.current = 0;
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
    };

    ws.onmessage = (e: MessageEvent<string>) => {
      try {
        const raw = JSON.parse(e.data) as Record<string, unknown>;
        if (!raw.event && raw.type) raw.event = raw.type;
        const normalized = raw as WsEvent;
        window.dispatchEvent(new CustomEvent("sentinel-ws-event", { detail: normalized }));
        msgCbRef.current(normalized);
      } catch {
        /* ignore malformed */
      }
    };

    ws.onclose = () => {
      statusCbRef.current("disconnected");
      if (disposedRef.current || !enabledRef.current || wsRef.current !== ws) {
        return;
      }
      const attempt = retryAttemptRef.current++;
      const baseMs = 750;
      const maxMs = 30_000;
      const exp = Math.min(6, attempt);
      const delay = Math.min(maxMs, baseMs * Math.pow(2, exp));
      const jitter = Math.floor(Math.random() * 500);
      retryTimer.current = setTimeout(() => {
        if (enabledRef.current) connect();
      }, delay + jitter);
    };

    ws.onerror = () => ws.close();
  }, []);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      disposedRef.current = true;
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
      return;
    }
    disposedRef.current = false;
    connect();
    return () => {
      disposedRef.current = true;
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect, enabled]);

  return { send };
}
