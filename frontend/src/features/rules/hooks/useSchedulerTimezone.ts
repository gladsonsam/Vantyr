import { useQuery } from "@tanstack/react-query";
import { settingsQueries } from "@/api/queries/settings";

/** The timezone scheduled scripts fire in (the server's), or null while it isn't known. */
export function useSchedulerTimezone(): string | null {
  return useQuery(settingsQueries.capabilities()).data?.scheduler_timezone || null;
}
