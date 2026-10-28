export function formatUptime(secs?: number) {
  if (secs == null || secs < 0) return "-";
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function formatLastSeen(timestamp: string | null | undefined) {
  if (!timestamp) return "Never";
  const parsed = new Date(timestamp).getTime();
  if (Number.isNaN(parsed)) return "Unknown";
  const diffSec = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  const mins = Math.floor(diffSec / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return `${diffSec}s ago`;
}

/** The hook fills missing text fields with "-"; views show explicit copy instead. */
export function hasValue(value: string | null | undefined): value is string {
  const trimmed = value?.trim();
  return Boolean(trimmed) && trimmed !== "-" && trimmed !== "—";
}

/** Tooltip for a value the device reported earlier instead of over the live feed. */
export function lastReportedTooltip(reportedAt: string | null | undefined) {
  if (!reportedAt) return undefined;
  const age = formatLastSeen(reportedAt);
  if (age === "Unknown") return undefined;
  return `Last reported ${age}`;
}

export function normalizeVersion(version: string | null | undefined) {
  return (version ?? "").trim().replace(/^v/i, "");
}

/** True when `latest` is a newer dotted version than `current` (so never for a downgrade). */
export function isNewerVersion(latest: string | null | undefined, current: string | null | undefined) {
  const parse = (version: string | null | undefined) =>
    normalizeVersion(version).split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10));
  const a = parse(latest);
  const b = parse(current);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/** Visual state (label/color/soft bg) for an agent row — mirrors the reference `statusTone`. */
export function fleetState(row: {
  online: boolean;
  status: string;
  internetBlocked?: boolean | null;
}): { label: string; color: string; soft: string } {
  if (!row.online) {
    return { label: "Offline", color: "var(--muted-foreground)", soft: "color-mix(in srgb, var(--muted) 55%, transparent)" };
  }
  if (row.status === "active") {
    return { label: "Active", color: "var(--success)", soft: "color-mix(in srgb, var(--success) 12%, transparent)" };
  }
  if (row.status === "afk") {
    return { label: "AFK", color: "var(--warning)", soft: "color-mix(in srgb, var(--warning) 12%, transparent)" };
  }
  return { label: "Online", color: "var(--success)", soft: "color-mix(in srgb, var(--success) 8%, transparent)" };
}
