import type { AgentCapabilityInfo, AgentInfo } from "./types";

export type CapabilityKey = keyof AgentCapabilityInfo;

const UNAVAILABLE = new Set(["unsupported", "unavailable", "not_supported", "disabled"]);
const CAUTION = new Set(["limited", "needs_permission", "needs_privilege"]);

export function capabilityStatus(info: AgentInfo | null | undefined, key: CapabilityKey): string | null {
  const value = info?.capabilities?.[key];
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

export function capabilityAvailable(info: AgentInfo | null | undefined, key: CapabilityKey): boolean {
  const status = capabilityStatus(info, key);
  if (!status) return true;
  return !UNAVAILABLE.has(status.toLowerCase());
}

export function capabilityFullySupported(info: AgentInfo | null | undefined, key: CapabilityKey): boolean {
  const status = capabilityStatus(info, key);
  if (!status) return true;
  return status.toLowerCase() === "supported";
}

export function capabilityNeedsCaution(info: AgentInfo | null | undefined, key: CapabilityKey): boolean {
  const status = capabilityStatus(info, key);
  return status ? CAUTION.has(status.toLowerCase()) : false;
}

export function platformShellOptions(info: AgentInfo | null | undefined) {
  const platform = capabilityStatus(info, "platform")?.toLowerCase();
  if (platform === "linux") {
    return [
      { label: "Shell (sh)", value: "sh" },
      { label: "Bash", value: "bash" },
    ];
  }
  return [
    { label: "PowerShell", value: "powershell" },
    { label: "Command Prompt (cmd)", value: "cmd" },
  ];
}

export function capabilityLabel(key: CapabilityKey): string {
  return key
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
