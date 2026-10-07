import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api";

export const settingsKeys = {
  all: ["settings"] as const,
  capabilities: () => [...settingsKeys.all, "capabilities"] as const,
};

export const settingsQueries = {
  /** Server feature switches (remote scripts allowed, scheduler timezone). */
  capabilities: () =>
    queryOptions({
      queryKey: settingsKeys.capabilities(),
      queryFn: () => api.capabilities(),
    }),
};
