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
  urls: (id: string, page: PageParams) => ["agents", id, "urls", page] as const,
};

export const agentQueries = {
  urls: (id: string, page: PageParams) =>
    queryOptions({
      queryKey: agentKeys.urls(id, page),
      queryFn: () => api.urls(id, page),
    }),
};
