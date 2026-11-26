import { useQuery } from "@tanstack/react-query";
import { networkQueries } from "@/api/queries/network";

/**
 * Whether the user holds `network_admin` on this household. The grants list is only served to
 * network administrators, so a successful read is the proof; a platform admin without the grant
 * gets a 403 here and sees the read-only screens. The server still enforces every write.
 */
export function useNetworkAdmin(household: string): boolean {
  const query = useQuery({
    ...networkQueries.grants(household),
    retry: false,
    staleTime: 60_000,
  });
  return query.isSuccess;
}
