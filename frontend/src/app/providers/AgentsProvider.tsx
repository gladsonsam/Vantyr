import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAgentStore } from "@/features/fleet/hooks/useAgentStore";
import { usePollDashboardServerVersion } from "./usePollDashboardServerVersion";
import { useWebSocket } from "@/api/useWebSocket";
import { AGENT_REMOVED_EVENT, type AgentRemovedEvent } from "@/api/agentEvents";
import { disconnectedAgent } from "@/features/fleet/lib/agentLifecycle";
import { api } from "@/api";
import type { Agent, AgentLiveStatus, WsEvent } from "@/api/types";
import { AgentsContext, type AgentsContextValue } from "./useAgents";
import { useNotifications } from "./useNotifications";
import { useSession } from "./useSession";

function toAgentMap(agents: Agent[]): Record<string, Agent> {
  const map: Record<string, Agent> = {};
  for (const agent of agents) map[agent.id] = agent;
  return map;
}

// Concurrency-limited fanout so we don't spam the server on large fleets.
async function withConcurrency<T>(items: string[], limit: number, fn: (id: string) => Promise<T>): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      await fn(items[idx]).catch(() => undefined);
    }
  });
  await Promise.all(runners);
}

/**
 * Owns the live fleet: the agent list and telemetry caches, the dashboard
 * WebSocket (only while signed in) and a 30 s background poll.
 */
export function AgentsProvider({ children }: { children: ReactNode }) {
  const { authenticated, refresh: refreshSession } = useSession();
  const { warning } = useNotifications();
  const location = useLocation();
  const navigate = useNavigate();
  const [wsInitReceived, setWsInitReceived] = useState(false);
  const {
    agents,
    liveStatus,
    agentInfo,
    agentInfoReceivedAtMs,
    updateAgent,
    updateAgentLiveStatus,
    updateAgentInfo,
    setAllAgents,
    setSelectedAgentId,
    removeAgent,
  } = useAgentStore();

  const handleAgentRemoved = useCallback((id: string) => {
    removeAgent(id);
    if (location.pathname === `/agents/${id}` || location.pathname.startsWith(`/agents/${id}/`)) {
      navigate("/", { replace: true });
    }
  }, [removeAgent, location.pathname, navigate]);

  useEffect(() => {
    const onRemoved = (event: Event) => {
      const id: unknown = (event as CustomEvent<unknown>).detail;
      if (typeof id === "string") handleAgentRemoved(id);
    };
    window.addEventListener(AGENT_REMOVED_EVENT, onRemoved);
    return () => window.removeEventListener(AGENT_REMOVED_EVENT, onRemoved);
  }, [handleAgentRemoved]);

  const refresh = useCallback(async () => {
    // One place to emulate a browser refresh: re-check auth + refetch the main caches we normally
    // seed on load (agents list + last-known telemetry + agent info).
    await refreshSession();

    let nextAgents: Agent[] = [];
    try {
      const res = await api.agentsOverview();
      nextAgents = Array.isArray(res?.agents) ? res.agents : [];
    } catch {
      return;
    }

    setAllAgents(toAgentMap(nextAgents));

    const ids = nextAgents.map((a) => a.id);
    if (ids.length === 0) {
      return;
    }

    await withConcurrency(ids, 8, async (id) => {
      // Accumulate only the fields we actually fetched into a patch; the hook merges it onto the
      // latest snapshot, so we never clobber concurrent live events with a stale render snapshot.
      const patch: Partial<AgentLiveStatus> = {};

      // Agent info (uptime/hostname/etc.)
      try {
        const infoRes = await api.agentInfo(id);
        updateAgentInfo(id, infoRes?.info ?? null);
      } catch {
        // keep stale
      }

      // Last window (fallback for when WS live events were missed/disconnected)
      try {
        const winRes = await api.windows(id, { limit: 1, offset: 0 });
        const row = Array.isArray(winRes?.rows) ? winRes.rows[0] : null;
        const title = typeof row?.title === "string" ? row.title : null;
        const app = typeof row?.app === "string" ? row.app : null;
        if (title && title.trim() !== "") {
          patch.window = title;
          if (app) patch.app = app;
        }
      } catch {
        // keep stale
      }

      // Last URL (same idea as last window; not shown on cards today but used across the UI)
      try {
        const urlRes = await api.urls(id, { limit: 1, offset: 0 });
        const row = Array.isArray(urlRes?.rows) ? urlRes.rows[0] : null;
        const url = typeof row?.url === "string" ? row.url : null;
        if (url && url.trim() !== "") {
          patch.url = url;
        }
      } catch {
        // keep stale
      }

      // Commit the merged patch (no-op merge is harmless when nothing was fetched).
      updateAgentLiveStatus(id, patch);
    });
  }, [refreshSession, setAllAgents, updateAgentInfo, updateAgentLiveStatus]);

  const wsEnabled = authenticated === true;

  // Keep the app-wide server/agent version banner fresh (only while signed in).
  usePollDashboardServerVersion(wsEnabled);

  useEffect(() => {
    if (authenticated !== true) {
      setWsInitReceived(false);
    }
  }, [authenticated]);

  const { send } = useWebSocket({
    enabled: wsEnabled,
    onMessage: (event: WsEvent | AgentRemovedEvent) => {
      switch (event.event) {
        case "init": {
          setAllAgents(toAgentMap(event.agents));
          setWsInitReceived(true);
          break;
        }

        case "agent_connected":
          if (event.agent_id && event.name) {
            const name = event.name;
            // Merge over the latest state so a concurrent icon/info update isn't lost.
            updateAgent(event.agent_id, (prev) => ({
              ...prev,
              id: event.agent_id,
              name,
              icon: prev?.icon ?? null,
              online: true,
              first_seen: prev?.first_seen || event.connected_at || "",
              last_seen: event.connected_at || "",
              connected_at: event.connected_at,
              last_connected_at: event.connected_at,
              last_disconnected_at: null,
            }));
          }
          break;

        case "agent_removed":
          handleAgentRemoved(event.agent_id);
          break;

        case "agent_disconnected":
          if (event.agent_id) {
            // No-op when the agent isn't known; otherwise flip online off in-place.
            updateAgent(event.agent_id, (prev) =>
              disconnectedAgent(prev, event.disconnected_at),
            );
          }
          break;

        case "window_focus":
          if (event.agent_id) {
            updateAgentLiveStatus(event.agent_id, {
              window: event.title,
              app: event.app,
            });
          }
          break;

        case "url":
          if (event.agent_id && event.url) {
            updateAgentLiveStatus(event.agent_id, {
              url: event.url,
            });
          }
          break;

        case "afk":
          if (event.agent_id) {
            const idleSecs = typeof event.idle_secs === "number" && event.idle_secs >= 0 ? event.idle_secs : 0;
            updateAgentLiveStatus(event.agent_id, {
              activity: "afk",
              idleSecs,
              idleSinceMs: Date.now() - idleSecs * 1000,
            });
          }
          break;

        case "active":
          if (event.agent_id) {
            updateAgentLiveStatus(event.agent_id, {
              activity: "active",
              idleSecs: 0,
              idleSinceMs: undefined,
            });
          }
          break;

        case "agent_info":
          if (event.agent_id && event.data) {
            updateAgentInfo(event.agent_id, event.data);
          }
          break;

        case "alert_rule_match": {
          const aid = event.agent_id;
          const agentLabel =
            (aid && agents[aid]?.name) || event.agent_name || aid || "Agent";
          const ruleLabel = event.rule_name || `Rule #${event.rule_id ?? "?"}`;
          const snippet = event.snippet ? ` — ${event.snippet}` : "";
          warning("Alert rule matched", `${ruleLabel} · ${agentLabel}${snippet}`);
          break;
        }
      }
    },
  });

  // Agent versions now come from the server's WS init payload (`agent_version` per agent),
  // so we don't need an N+1 `/agents/:id/info` prefetch here.

  // Background poll every 30 s to keep online/offline state fresh in case WS events are missed.
  useEffect(() => {
    if (authenticated !== true) return;
    const poll = async () => {
      try {
        const res = await api.agentsOverview();
        const nextAgents = Array.isArray(res?.agents) ? res.agents : [];
        setAllAgents(toAgentMap(nextAgents));
      } catch { /* ignore */ }
    };
    const id = window.setInterval(poll, 30_000);
    return () => window.clearInterval(id);
  }, [authenticated, setAllAgents]);

  const value = useMemo<AgentsContextValue>(
    () => ({
      agents,
      liveStatus,
      agentInfo,
      agentInfoReceivedAtMs,
      initialized: wsInitReceived,
      setSelectedAgentId,
      send,
      refresh,
    }),
    [agents, liveStatus, agentInfo, agentInfoReceivedAtMs, wsInitReceived, setSelectedAgentId, send, refresh],
  );

  return <AgentsContext.Provider value={value}>{children}</AgentsContext.Provider>;
}
