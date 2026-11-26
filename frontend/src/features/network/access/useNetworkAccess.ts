import { useQuery } from "@tanstack/react-query";
import { isApiError } from "@/api";
import type { NetworkHousehold } from "@/api/types";
import { networkQueries } from "@/api/queries/network";
import { useSession } from "@/app/providers/useSession";

/**
 * Whether the signed-in user can use Vantyr Network. Network access is its own scope
 * (`network_admin` / `network_events` grants): the dashboard's admin/operator/viewer roles never
 * imply it, so this is decided only by what the server returns for the user's households.
 */
export type NetworkAccess =
  | { state: "loading" }
  /** The server has no Network API. */
  | { state: "unavailable" }
  /** The server has it but this user holds no grant. */
  | { state: "denied" }
  /** No household exists yet and this user may create the first one. */
  | { state: "setup" }
  | { state: "error"; message: string; retry: () => void }
  | { state: "ready"; household: NetworkHousehold };

export function useNetworkAccess(): NetworkAccess {
  const { user } = useSession();
  const query = useQuery(networkQueries.households());

  if (query.isPending) return { state: "loading" };
  if (query.isError) {
    const error = query.error;
    if (isApiError(error) && error.status === 404) return { state: "unavailable" };
    if (isApiError(error) && error.status === 403) return { state: "denied" };
    return {
      state: "error",
      message: error instanceof Error ? error.message : "Request failed",
      retry: () => void query.refetch(),
    };
  }

  const households = query.data.households;
  const household = households.find((h) => h.is_default) ?? households[0];
  if (household) return { state: "ready", household };
  // Only a platform admin may bootstrap; everyone else simply has no household to see.
  return user?.role === "admin" ? { state: "setup" } : { state: "denied" };
}
