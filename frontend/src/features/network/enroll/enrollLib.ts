import { useEffect, useState } from "react";
import type { NetworkSelfDeviceType, NetworkSetupPurpose } from "@/api/types";

export const SELF_DEVICE_TYPE_LABEL: Record<NetworkSelfDeviceType, string> = {
  computer: "Computer",
  phone: "Phone",
  tablet: "Tablet",
  tv: "TV",
  iot: "Smart device",
  other: "Other",
};

export function deviceTypeLabel(type: string): string {
  return type in SELF_DEVICE_TYPE_LABEL
    ? SELF_DEVICE_TYPE_LABEL[type as NetworkSelfDeviceType]
    : type;
}

export const PURPOSE_LABEL: Record<NetworkSetupPurpose, string> = {
  proxy_setup: "Proxy setup",
  dns_setup: "DNS setup",
};

export function purposeLabel(purpose: string): string {
  return purpose in PURPOSE_LABEL ? PURPOSE_LABEL[purpose as NetworkSetupPurpose] : purpose;
}

/** Seconds left until `iso`, ticking once a second; 0 once it has passed. */
export function useSecondsLeft(iso: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [iso]);
  if (!iso) return 0;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 1000));
}

export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
