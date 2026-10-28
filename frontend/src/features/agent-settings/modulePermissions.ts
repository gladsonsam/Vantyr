import type { DeviceModuleId, ModuleStopRequest } from "@/api/types";
import { MODULE_LABELS, moduleLabel } from "@vantyr/ui/lib/moduleLabels";

// Typed against the server's module catalogue, so a new module is a compile error until it has a label.
const labels: Record<DeviceModuleId, string> = MODULE_LABELS;
export const DEVICE_MODULE_NAMES = Object.keys(labels) as DeviceModuleId[];
export { moduleLabel };
export function stopRequestLabel(status: string): string {
  if (["disabled", "duplicate", "confirmed", "acknowledged"].includes(status)) return "Permission revocation confirmed";
  if (status === "stale") return "Device authorization changed; refresh and request again";
  if (status === "conflict") return "Request conflict; refresh and request again";
  if (status === "error" || status === "failed") return "Stop request failed";
  if (status === "sent") return "Sent; waiting for device confirmation";
  return "Queued; waiting for device confirmation";
}

export function workerStopLabel(request: ModuleStopRequest): string {
  if (request.stopped === true) return "Device confirmed worker shutdown";
  if (request.stop_status === "local_barrier_timeout") return "Some local operations are still finishing";
  if (request.stop_status === "registered_local_workers_drained_global_unconfirmed") return "Registered local workers stopped; full device shutdown remains unconfirmed";
  return "Worker shutdown remains unconfirmed";
}
