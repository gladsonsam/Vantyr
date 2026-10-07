import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api";
import type { PageParams } from "@/api/client";

/**
 * Per-agent server state lives under `["agents", id, …]`, so invalidating `agentKeys.agent(id)`
 * refreshes everything shown for one device.
 */
export const agentKeys = {
  all: ["agents"] as const,
  agent: (id: string) => ["agents", id] as const,
  info: (id: string) => ["agents", id, "info"] as const,
  urls: (id: string, page: PageParams) => ["agents", id, "urls", page] as const,
  keys: (id: string, page: PageParams) => ["agents", id, "keys", page] as const,
  windows: (id: string, page: PageParams) => ["agents", id, "windows", page] as const,
  topWindows: (id: string, page: PageParams) => ["agents", id, "top-windows", page] as const,
  software: (id: string) => ["agents", id, "software"] as const,
  metrics: (id: string, hours: number) => ["agents", id, "metrics", hours] as const,
  logSources: (id: string) => ["agents", id, "logs", "sources"] as const,
  logTail: (id: string, kind: string) => ["agents", id, "logs", "tail", kind] as const,
};

export const agentQueries = {
  /** System-info snapshot (`null` until the agent has reported one). */
  info: (id: string) =>
    queryOptions({
      queryKey: agentKeys.info(id),
      queryFn: () => api.agentInfo(id),
    }),
  urls: (id: string, page: PageParams) =>
    queryOptions({
      queryKey: agentKeys.urls(id, page),
      queryFn: () => api.urls(id, page),
    }),
  keys: (id: string, page: PageParams) =>
    queryOptions({
      queryKey: agentKeys.keys(id, page),
      queryFn: () => api.keys(id, page),
    }),
  windows: (id: string, page: PageParams) =>
    queryOptions({
      queryKey: agentKeys.windows(id, page),
      queryFn: () => api.windows(id, page),
    }),
  topWindows: (id: string, page: PageParams) =>
    queryOptions({
      queryKey: agentKeys.topWindows(id, page),
      queryFn: () => api.topWindows(id, page),
    }),
  software: (id: string) =>
    queryOptions({
      queryKey: agentKeys.software(id),
      queryFn: () => api.agentSoftware(id),
    }),
  /** Resource samples for the last `hours`, counted back from the moment of each fetch. */
  metrics: (id: string, hours: number) =>
    queryOptions({
      queryKey: agentKeys.metrics(id, hours),
      queryFn: () => api.agentMetrics(id, new Date(Date.now() - hours * 3600 * 1000).toISOString()),
    }),
  logSources: (id: string) =>
    queryOptions({
      queryKey: agentKeys.logSources(id),
      queryFn: () => api.agentLogSources(id),
    }),
  logTail: (id: string, kind: string) =>
    queryOptions({
      queryKey: agentKeys.logTail(id, kind),
      queryFn: () => api.agentLogTail(id, { kind, maxKb: 512 }),
    }),
};
