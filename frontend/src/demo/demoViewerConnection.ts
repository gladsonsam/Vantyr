import { useCallback, useEffect, useRef } from "react";
import type { WsEvent, WsStatus } from "@/api/types";
import type { ViewerConnection, ViewerConnectionOptions } from "@/api/viewerConnection";
import { demoAgents, demoAgentInfo, demoLiveStatus } from "./data";

const LEASE_MESSAGES = ["control_acquire", "control_heartbeat", "control_release"];

/**
 * Demo mode has no server: this stands in for the viewer WebSocket, announcing the fake fleet,
 * drifting its live status, and answering remote-control lease commands locally.
 */
export const useDemoViewerConnection: ViewerConnection = ({ onMessage, onStatusChange, enabled = true }: ViewerConnectionOptions) => {
  const leases = useRef(new Map<string, string>());
  const msgCbRef = useRef(onMessage);
  const statusCbRef = useRef(onStatusChange);
  msgCbRef.current = onMessage;
  statusCbRef.current = onStatusChange;

  const reportStatus = useCallback((status: WsStatus) => {
    statusCbRef.current?.(status);
  }, []);

  const send = useCallback((data: unknown) => {
    const message = data as Record<string, unknown>;
    if (!LEASE_MESSAGES.includes(String(message.type))) return;
    const id = String(message.agent_id), current = leases.current.get(id);
    const matching = current === message.lease_token;
    let token = current;
    let status: "granted" | "released" | "denied" = "denied";
    if (message.type === "control_acquire" && demoAgents.some(agent => agent.id === id && agent.online)) { token = current ?? crypto.randomUUID(); leases.current.set(id, token); status = "granted"; }
    if (message.type === "control_heartbeat" && current && matching) status = "granted";
    if (message.type === "control_release" && current && matching) { leases.current.delete(id); status = "released"; }
    const event: WsEvent = { event: "control_lease", agent_id: id, request_id: typeof message.request_id === "string" ? message.request_id : undefined, status, ...(status === "granted" ? {lease_token: token, expires_in_ms: 15000} : {}), ...(status === "denied" ? {error: "Demo device is offline or the control session ended"} : {}) };
    queueMicrotask(() => msgCbRef.current(event));
  }, []);

  useEffect(() => {
    if (!enabled) {
      reportStatus("disconnected");
      return;
    }
    const emit = (event: WsEvent) => msgCbRef.current(event);

    reportStatus("connecting");
    const initTimer = setTimeout(() => {
      reportStatus("connected");
      emit({ event: "init", agents: demoAgents });
      for (const [agentId, info] of Object.entries(demoAgentInfo)) {
        emit({ event: "agent_info", agent_id: agentId, data: info });
      }
      for (const [agentId, status] of Object.entries(demoLiveStatus)) {
        if (status.window || status.app) {
          emit({
            event: "window_focus",
            agent_id: agentId,
            title: status.window,
            app: status.app,
          });
        }
        if (status.url) {
          emit({ event: "url", agent_id: agentId, url: status.url });
        }
        if (status.activity === "afk") {
          emit({ event: "afk", agent_id: agentId, idle_secs: status.idleSecs ?? 300 });
        } else if (status.activity === "active") {
          emit({ event: "active", agent_id: agentId });
        }
      }
    }, 250);

    let tick = 0;
    const updateTimer = setInterval(() => {
      const online = demoAgents.filter((a) => a.online);
      const agent = online[tick % online.length];
      tick += 1;
      const status = agent && demoLiveStatus[agent.id];
      if (!agent || !status) return;
      emit({
        event: "window_focus",
        agent_id: agent.id,
        title: status.window,
        app: status.app,
      });
      emit(tick % 5 === 0 ? { event: "afk", agent_id: agent.id, idle_secs: 180 } : { event: "active", agent_id: agent.id });
    }, 8_000);

    return () => {
      clearTimeout(initTimer);
      clearInterval(updateTimer);
      reportStatus("disconnected");
    };
  }, [enabled, reportStatus]);

  return { send };
};
