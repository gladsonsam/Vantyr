import type { ActivityEvent, Agent, AgentInfo, AgentMetricsResponse, AgentSoftwareRow, FleetSummaryResponse, KeySession, UrlTopRow, UrlVisit, WindowEvent, WindowTopRow } from "@/api/types";
import { get, requestJson, putJson, postEmpty, postJsonRes, csrfHeaders, type PageParams } from "@/api/client";
import { notifyAgentRemoved } from "@/api/agentEvents";

export const agentsEndpoints = {
  // ── Dashboard data ────────────────────────────────────────────────────────

  /** Agent directory with live `online` + session timestamps (use for all dashboard lists). */
  agentsOverview: (): Promise<{ agents: Agent[] }> => get("/agents/overview"),

  /** One bounded fleet batch. Callers split larger fleets; detail APIs stay independent. */
  fleetSummary: (ids: readonly string[], signal?: AbortSignal): Promise<FleetSummaryResponse> => {
    const unique = [...new Set(ids)];
    if (!unique.length || unique.length > 100 || unique.some(id => !id || id.includes(",")) || unique.join(",").length > 8192) return Promise.reject(new Error("Fleet summary requires 1–100 agent IDs"));
    const query = new URLSearchParams({ ids: unique.join(",") });
    return requestJson(`/agents/fleet-summary?${query}`, { method: "GET", signal }, { includePathInHttpError: true });
  },

  // ── Agent UI metadata ─────────────────────────────────────────────────────

  agentIconGet: (id: string): Promise<{ icon: string | null }> =>
    get(`/agents/${id}/icon`),

  agentIconPut: (id: string, icon: string | null): Promise<{ icon: string | null }> =>
    putJson(`/agents/${id}/icon`, { icon }),

  windows: (
    id: string,
    { limit = 100, offset = 0 }: PageParams = {},
  ): Promise<{ rows: WindowEvent[] }> =>
    get(`/agents/${id}/windows?limit=${limit}&offset=${offset}`),

  keys: (
    id: string,
    { limit = 100, offset = 0 }: PageParams = {},
  ): Promise<{ rows: KeySession[] }> =>
    get(`/agents/${id}/keys?limit=${limit}&offset=${offset}`),

  urls: (
    id: string,
    { limit = 100, offset = 0 }: PageParams = {},
  ): Promise<{ rows: UrlVisit[] }> =>
    get(`/agents/${id}/urls?limit=${limit}&offset=${offset}`),

  activity: (
    id: string,
    { limit = 100, offset = 0 }: PageParams = {},
  ): Promise<{ rows: ActivityEvent[] }> =>
    get(`/agents/${id}/activity?limit=${limit}&offset=${offset}`),

  agentInfo: (id: string): Promise<{ info: AgentInfo | null }> =>
    get(`/agents/${id}/info`),

  /** Resource health history (CPU/mem/disk) for an agent over a time range. */
  agentMetrics: (
    id: string,
    fromIso?: string,
    toIso?: string,
  ): Promise<AgentMetricsResponse> => {
    const params = new URLSearchParams();
    if (fromIso) params.set("from", fromIso);
    if (toIso) params.set("to", toIso);
    const qs = params.toString();
    return get(`/agents/${id}/metrics${qs ? `?${qs}` : ""}`);
  },

  topUrls: (
    id: string,
    { limit = 100, offset = 0 }: PageParams = {},
  ): Promise<{ rows: UrlTopRow[] }> =>
    get(`/agents/${id}/top-urls?limit=${limit}&offset=${offset}`),

  topWindows: (
    id: string,
    { limit = 100, offset = 0 }: PageParams = {},
  ): Promise<{ rows: WindowTopRow[] }> =>
    get(`/agents/${id}/top-windows?limit=${limit}&offset=${offset}`),

  // ── Destructive actions ────────────────────────────────────────────────
  /** Clear all stored telemetry history for this agent (windows/keys/urls/activity). */
  clearAgentHistory: (id: string): Promise<{ cleared_rows: number }> =>
    postEmpty(`/agents/${id}/history/clear`),

  /** Wake-on-LAN using MAC from last stored system info (`POST`, optional `broadcast`, `port`). */
  wakeAgent: async (
    id: string,
    opts?: { broadcast?: string; port?: number },
  ): Promise<{ ok: boolean; mac: string; broadcast: string; port: number }> => {
    const p = new URLSearchParams();
    if (opts?.broadcast) p.set("broadcast", opts.broadcast);
    if (opts?.port != null) p.set("port", String(opts.port));
    const qs = p.toString();
    const body = await requestJson<{
      ok?: boolean;
      mac?: string;
      broadcast?: string;
      port?: number;
      retry_after_secs?: number;
    }>(`/agents/${id}/wake${qs ? `?${qs}` : ""}`, {
      method: "POST",
      headers: { ...csrfHeaders() },
    });
    return {
      ok: body.ok ?? true,
      mac: body.mac ?? "",
      broadcast: body.broadcast ?? "",
      port: body.port ?? 9,
    };
  },

  /** Admin: delete agents (forgets them). */
  deleteAgents: (agentIds: string[]): Promise<{ ok: boolean; deleted: number }> =>
    postJsonRes<{ ok: boolean; deleted: number }>("/agents/delete", { agent_ids: agentIds }).then((result) => {
      if (result.ok && result.deleted === new Set(agentIds).size) agentIds.forEach(notifyAgentRemoved);
      return result;
    }),

  agentSoftware: (
    id: string,
    params?: { limit?: number; offset?: number },
  ): Promise<{
    rows: AgentSoftwareRow[];
    last_captured_at: string | null;
    total?: number;
    limit?: number;
    offset?: number;
  }> => {
    const qs = new URLSearchParams();
    if (params?.limit != null) qs.set("limit", String(params.limit));
    if (params?.offset != null) qs.set("offset", String(params.offset));
    const q = qs.toString();
    return get(`/agents/${id}/software${q ? `?${q}` : ""}`);
  },

  collectAgentSoftware: (id: string): Promise<{ ok: boolean }> =>
    postEmpty(`/agents/${id}/software/collect`),

  runAgentScript: (
    id: string,
    body: { shell: string; script: string; timeout_secs?: number },
  ): Promise<Record<string, unknown>> => postJsonRes(`/agents/${id}/script`, body),

  agentLogSources: (
    id: string,
  ): Promise<{
    sources: { id: string; label: string; path: string }[];
  }> =>
    get(`/agents/${id}/logs/sources`).then((r: unknown) => {
      const sourcesRaw =
        r != null && typeof r === "object" && "sources" in r
          ? (r as { sources?: unknown }).sources
          : undefined;
      const sources = Array.isArray(sourcesRaw)
        ? sourcesRaw.map((s): { id: string; label: string; path: string } => {
            const obj = s != null && typeof s === "object" ? (s as Record<string, unknown>) : {};
            const id = String(obj.id ?? "");
            const label = String(obj.label ?? obj.id ?? "");
            const path = String(obj.path ?? "");
            return { id, label, path };
          })
        : [];
      return { sources };
    }),

  agentLogTail: (
    id: string,
    params?: { kind?: string; maxKb?: number },
  ): Promise<{ kind: string; text: string }> => {
    const q = new URLSearchParams();
    if (params?.kind) q.set("kind", params.kind);
    if (params?.maxKb != null) q.set("max_kb", String(params.maxKb));
    const qs = q.toString();
    return get(`/agents/${id}/logs/tail${qs ? `?${qs}` : ""}`).then((r: unknown) => {
      const obj = r != null && typeof r === "object" ? (r as Record<string, unknown>) : {};
      return {
        kind: String(obj.kind ?? params?.kind ?? ""),
        text: String(obj.text ?? ""),
      };
    });
  },

  bulkAgentScript: (body: {
    agent_ids: string[];
    shell: string;
    script: string;
    timeout_secs?: number;
  }): Promise<{ results: Record<string, unknown>[] }> =>
    postJsonRes("/agents/bulk-script", body),
};
