import { useEffect, useRef, useCallback } from "react";
import type { WsEvent } from "../lib/types";
import { buildViewerWsUrl } from "../lib/serverSettings";
import { demoAgents, demoAgentInfo, demoLiveStatus } from "../demo/data";
import { isDemoMode } from "../demo/mode";

type WsStatus = "connecting" | "connected" | "disconnected";

interface Options {
  onMessage: (ev: WsEvent) => void;
  onStatusChange: (s: WsStatus) => void;
  /** When false, no socket is opened (saves work until the user is logged in). */
  enabled?: boolean;
}

export function useWebSocket({ onMessage, onStatusChange, enabled = true }: Options) {
  const demoLeases = useRef(new Map<string, string>());
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

  const reportStatus = useCallback((status: WsStatus) => {
    window.dispatchEvent(new CustomEvent("vantyr-ws-status", { detail: status }));
    statusCbRef.current(status);
  }, []);

  const connect = useCallback(() => {
    const ws = new WebSocket(buildViewerWsUrl());
    wsRef.current = ws;

    reportStatus("connecting");

    ws.onopen = () => {
      if (disposedRef.current || !enabledRef.current || wsRef.current !== ws) return;
      reportStatus("connected");
      retryAttemptRef.current = 0;
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
    };

    ws.onmessage = (e: MessageEvent<string>) => {
      if (disposedRef.current || !enabledRef.current || wsRef.current !== ws) return;
      try {
        const raw = JSON.parse(e.data) as Record<string, unknown>;
        if (!raw.event && raw.type) raw.event = raw.type;
        const normalized = raw as WsEvent;
        window.dispatchEvent(new CustomEvent("vantyr-ws-event", { detail: normalized }));
        msgCbRef.current(normalized);
      } catch {
        /* ignore malformed */
      }
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      reportStatus("disconnected");
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
  }, [reportStatus]);

  const send = useCallback((data: unknown) => {
    if (isDemoMode) {
      const message = data as Record<string, unknown>;
      if (["control_acquire", "control_heartbeat", "control_release"].includes(String(message.type))) {
        const id = String(message.agent_id), current = demoLeases.current.get(id);
        const matching = current === message.lease_token;
        let token = current;
        let status: "granted" | "released" | "denied" = "denied";
        if (message.type === "control_acquire" && demoAgents.some(agent => agent.id === id && agent.online)) { token = current ?? crypto.randomUUID(); demoLeases.current.set(id, token); status = "granted"; }
        if (message.type === "control_heartbeat" && current && matching) status = "granted";
        if (message.type === "control_release" && current && matching) { demoLeases.current.delete(id); status = "released"; }
        const event = { event: "control_lease", agent_id: id, request_id: message.request_id, status, ...(status === "granted" ? {lease_token: token, expires_in_ms: 15000} : {}), ...(status === "denied" ? {error: "Demo device is offline or the control session ended"} : {}) };
        queueMicrotask(() => window.dispatchEvent(new CustomEvent("vantyr-ws-event", { detail: event })));
      }
      window.dispatchEvent(new CustomEvent("vantyr-demo-ws-send", { detail: data }));
      return;
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  useEffect(() => {
    if (isDemoMode) {
      if (!enabled) {
        reportStatus("disconnected");
        return;
      }

      reportStatus("connecting");
      const initTimer = setTimeout(() => {
        reportStatus("connected");
        emitDemo({ event: "init", agents: demoAgents });
        for (const [agentId, info] of Object.entries(demoAgentInfo)) {
          emitDemo({ event: "agent_info", agent_id: agentId, data: info });
        }
        for (const [agentId, status] of Object.entries(demoLiveStatus)) {
          if (status.window || status.app) {
            emitDemo({
              event: "window_focus",
              agent_id: agentId,
              title: status.window,
              app: status.app,
            });
          }
          if (status.url) {
            emitDemo({ event: "url", agent_id: agentId, url: status.url });
          }
          if (status.activity === "afk") {
            emitDemo({ event: "afk", agent_id: agentId, idle_secs: status.idleSecs ?? 300 });
          } else if (status.activity === "active") {
            emitDemo({ event: "active", agent_id: agentId });
          }
        }
      }, 250);

      let tick = 0;
      const updateTimer = setInterval(() => {
        const online = demoAgents.filter((a) => a.online);
        const agent = online[tick % online.length];
        const status = demoLiveStatus[agent.id];
        tick += 1;
        if (!agent || !status) return;
        emitDemo({
          event: "window_focus",
          agent_id: agent.id,
          title: status.window,
          app: status.app,
        });
        emitDemo(tick % 5 === 0 ? { event: "afk", agent_id: agent.id, idle_secs: 180 } : { event: "active", agent_id: agent.id });
      }, 8_000);

      return () => {
        clearTimeout(initTimer);
        clearInterval(updateTimer);
        reportStatus("disconnected");
      };
    }

    if (!enabled) {
      disposedRef.current = true;
      reportStatus("disconnected");
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
      reportStatus("disconnected");
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect, enabled, reportStatus]);

  return { send };

  function emitDemo(event: WsEvent) {
    window.dispatchEvent(new CustomEvent("vantyr-ws-event", { detail: event }));
    msgCbRef.current(event);
  }
}
