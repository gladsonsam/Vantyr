import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api";

export const notificationKeys = {
  all: ["notifications"] as const,
  /** Which alert delivery channels the server has configured. */
  status: () => [...notificationKeys.all, "status"] as const,
};

export const notificationQueries = {
  status: () =>
    queryOptions({
      queryKey: notificationKeys.status(),
      queryFn: () => api.notificationsStatus(),
    }),
};
