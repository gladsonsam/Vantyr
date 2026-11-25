import type { AgentInfo } from "@/api/types";

type Adapter = NonNullable<AgentInfo["adapters"]>[number];
type Drive = NonNullable<AgentInfo["drives"]>[number];
type Monitor = NonNullable<AgentInfo["monitors"]>[number];

export function isIpv4Address(ip: string): boolean {
  const t = ip.trim();
  if (!t || t.includes(":")) return false;
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(t);
}

/** Split addresses into IPv4 and IPv6 lists (original order preserved in each). */
export function partitionIpAddresses(ips: readonly string[]): { v4: string[]; v6: string[] } {
  const v4: string[] = [];
  const v6: string[] = [];
  for (const ip of ips) {
    const trimmed = ip.trim();
    if (!trimmed) continue;
    (isIpv4Address(trimmed) ? v4 : v6).push(trimmed);
  }
  return { v4, v6 };
}

function isLoopbackIp(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  return v === "::1" || v.startsWith("127.");
}

/** 169.254.x.x / fe80::… — an address the adapter gave itself because nothing handed it a real one. */
function isLinkLocalIp(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  return v.startsWith("169.254.") || v.startsWith("fe80:");
}

const LOOPBACK_TEXT = /\b(loopback|pseudo-interface|localhost)\b/i;

/**
 * Adapters worth reading first are the ones with a real address or a gateway. Loopback adapters and
 * ones holding only self-assigned (link-local) addresses with no gateway go to a folded group, so an
 * unplugged WiFi or Bluetooth adapter does not look like the machine's connection.
 */
export function partitionAdapters(adapters: readonly Adapter[]): { active: Adapter[]; inactive: Adapter[] } {
  const active: Adapter[] = [];
  const inactive: Adapter[] = [];
  for (const adapter of adapters) {
    const ips = adapter.ips ?? [];
    const byText = LOOPBACK_TEXT.test(adapter.name ?? "") || LOOPBACK_TEXT.test(adapter.description ?? "");
    const onlyLoopback = ips.length > 0 && ips.every(isLoopbackIp);
    const hasGateway = (adapter.gateways ?? []).some((gateway) => gateway.trim());
    const onlyLinkLocal = ips.length > 0 && ips.every((ip) => isLinkLocalIp(ip) || isLoopbackIp(ip));
    const unconfigured = ips.length === 0 && !hasGateway;
    (byText || onlyLoopback || (onlyLinkLocal && !hasGateway) || unconfigured ? inactive : active).push(adapter);
  }
  return { active, inactive };
}

/** Distinct, non-empty values in their original order. */
export function uniqueValues(values: readonly string[] | null | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

/** `826.1 GB`; the exact two-decimal figure stays available as a tooltip. */
export function formatGb(gb: number): string {
  return `${gb.toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} GB`;
}

export interface DriveUsage {
  total: number;
  free: number;
  used: number;
  /** Whole percent used, 0 when the size is unknown. */
  pct: number;
}

export function driveUsage(drive: Pick<Drive, "total_gb" | "available_gb">): DriveUsage {
  const total = drive.total_gb ?? 0;
  const free = drive.available_gb ?? 0;
  const used = Math.max(0, total - free);
  return { total, free, used, pct: total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0 };
}

/** "C:" and "C:\" are the same drive: only show the mount point when it adds something. */
export function mountAddsInfo(drive: Pick<Drive, "name" | "mount_point">): boolean {
  const mount = (drive.mount_point ?? "").trim();
  if (!mount) return false;
  const strip = (value: string) => value.replace(/[\\/]+$/, "").toLowerCase();
  return strip(mount) !== strip(drive.name ?? "");
}

export function formatDisplays(monitors: readonly Monitor[] | undefined): string {
  if (!monitors?.length) return "";
  return monitors
    .map((monitor) => {
      const size = monitor.width && monitor.height ? `${monitor.width}×${monitor.height}` : "";
      return [size, monitor.primary && monitors.length > 1 ? "primary" : ""].filter(Boolean).join(" ");
    })
    .filter(Boolean)
    .join(", ");
}

export function formatMemoryGb(totalMb: number | undefined): string {
  if (!totalMb || totalMb <= 0) return "";
  const gb = totalMb / 1024;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

export function formatProcessor(info: Pick<AgentInfo, "cpu_brand" | "cpu_cores">): string {
  const brand = info.cpu_brand?.trim() ?? "";
  const cores = info.cpu_cores ? `${info.cpu_cores} ${info.cpu_cores === 1 ? "core" : "cores"}` : "";
  return [brand, cores].filter(Boolean).join(" · ");
}

export interface Fact {
  label: string;
  value: string;
  /** Identifier or path: monospace, copy button. */
  copy?: boolean;
}

/** Facts with a value, in order; missing ones are left out instead of printing "—". */
export function presentFacts(facts: ReadonlyArray<{ label: string; value?: string | null; copy?: boolean }>): Fact[] {
  return facts.flatMap(({ label, value, copy }) => {
    const text = value?.trim();
    return text ? [{ label, value: text, copy }] : [];
  });
}
