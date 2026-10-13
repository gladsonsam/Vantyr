import { useQuery } from "@tanstack/react-query";
import type { DeviceModuleId } from "@/api/types";
import { moduleQueries } from "@/api/queries/modules";

/**
 * The device's local module grants, for gating features before they hit a refusal.
 * `granted(m)` is null when unknown (viewer role, still loading, or an agent too old
 * to report), so callers keep their usual behaviour; false means the device has it off.
 */
export function useDeviceModuleGrants(agentId: string, enabled: boolean) {
  // The endpoint is operator-only; viewers never ask.
  const query = useQuery({ ...moduleQueries.status(agentId), enabled, refetchInterval: 10_000, refetchIntervalInBackground: false, retry: false });
  const modules = enabled ? query.data?.state?.modules ?? null : null;
  const granted = (module: DeviceModuleId): boolean | null => {
    const grant = modules?.find(g => g.module === module);
    return grant ? grant.available && grant.enabled : null;
  };
  /** Every available module is off: the device has never been set up (e.g. right after upgrading to grants). */
  const noneGranted = modules != null && modules.some(g => g.available) && !modules.some(g => g.available && g.enabled);
  return { granted, noneGranted };
}
