import { isNewerVersion, normalizeVersion } from "@/features/fleet/lib/fleetUtils";

export type AutoUpdateChoice = "inherit" | "on" | "off";

export type VersionState = "installed-unknown" | "latest-unknown" | "available" | "current";

/** Installed version against the latest the server knows of. Unknown on either side is never "up to date". */
export function versionState(installed: string | null, latest: string | null): VersionState {
  if (!normalizeVersion(installed)) return "installed-unknown";
  if (!normalizeVersion(latest)) return "latest-unknown";
  return isNewerVersion(latest, installed) ? "available" : "current";
}

export function versionLabel(version: string | null): string {
  const clean = normalizeVersion(version);
  return clean ? `v${clean}` : "Unknown";
}

/** A request the person sent; `from` is the version the device reported at that moment. */
export interface UpdateRequest {
  at: number;
  from: string;
}

export type UpdateRequestOutcome =
  { kind: "waiting"; at: number } | { kind: "changed"; from: string; to: string };

/**
 * An acknowledged command only means the server sent it. The only proof an update happened is the
 * device reporting a different installed version afterwards.
 */
export function updateRequestOutcome(
  request: UpdateRequest | null,
  installed: string | null,
): UpdateRequestOutcome | null {
  if (!request) return null;
  const now = normalizeVersion(installed);
  if (now && now !== request.from) return { kind: "changed", from: request.from, to: now };
  return { kind: "waiting", at: request.at };
}

export function autoUpdateChoice(override: { enabled: boolean } | null): AutoUpdateChoice {
  return override === null ? "inherit" : override.enabled ? "on" : "off";
}

const onOff = (enabled: boolean) => (enabled ? "On" : "Off");

/** What the device is set to do, and where that comes from. */
export function autoUpdateEffective(
  globalEnabled: boolean | null,
  override: { enabled: boolean } | null,
): string {
  if (override) {
    const base = globalEnabled === null ? "" : `; the server default is ${onOff(globalEnabled)}`;
    return `${onOff(override.enabled)}: set for this device${base}.`;
  }
  return globalEnabled === null
    ? "Following the server default."
    : `${onOff(globalEnabled)}: following the server default.`;
}
