import type { DeviceModuleStatus, RecallSettings } from "@/api/types";

export type CaptureTone = "success" | "warning" | "muted";

export interface DeviceCaptureState {
  tone: CaptureTone;
  text: string;
}

/**
 * What the device itself says about Recall, next to what the settings ask for. Saving capture
 * settings never grants permission: the device owner turns the Recall module on locally, so a
 * saved "record" is only ever a request until the device's own report shows it authorized.
 * `status` is null while unknown (still loading, failed, or a viewer, who cannot read it).
 */
export function deviceCaptureState(settingsOn: boolean, status: DeviceModuleStatus | null, canSeeDevice: boolean): DeviceCaptureState {
  if (!settingsOn) return { tone: "muted", text: "Capture is off in saved settings. The device has not confirmed applying them." };
  if (!canSeeDevice) {
    return { tone: "muted", text: "Whether the device allows Recall is shown to operators." };
  }
  const grant = status?.state?.modules.find((module) => module.module === "recall");
  if (!status || !grant) {
    return { tone: "warning", text: "This device has not reported whether it allows Recall. Current permission is unconfirmed." };
  }
  if (!grant.available) {
    return { tone: "warning", text: status.online && status.authorization_current ? "This device or its app version cannot run Recall." : "At its last report, this device or its app version could not run Recall. Current availability is unconfirmed." };
  }
  if (!grant.enabled) {
    return {
      tone: "warning",
      text: `${status.online && status.authorization_current ? "This device reports Recall off." : "Recall was off at its last report. Current permission is unconfirmed."} Only someone at the device can turn it on, in its Vantyr app.`,
    };
  }
  if (!status.online) return { tone: "muted", text: "The device allowed Recall at its last report, and is offline now." };
  if (!status.authorization_current) return { tone: "muted", text: "The device allowed Recall in an earlier report; waiting for a current one." };
  return { tone: "success", text: "The device allows Recall." };
}

const SETTING_KEYS: (keyof RecallSettings)[] = [
  "enabled",
  "interval_ms",
  "hot_interval_ms",
  "jpeg_quality",
  "max_dim",
  "dedup_hamming",
  "keyframe_max_gap_ms",
  "ocr",
];

export function sameRecallSettings(a: RecallSettings, b: RecallSettings): boolean {
  return SETTING_KEYS.every((key) => a[key] === b[key]);
}
