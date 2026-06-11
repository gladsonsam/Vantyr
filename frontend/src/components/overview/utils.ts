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

export function normalizeVersion(version: string | null | undefined) {
  return (version ?? "").trim().replace(/^v/i, "");
}

/** Visual state (label/color/soft bg) for an agent row — mirrors the reference `stateOf`. */
export function fleetState(row: {
  online: boolean;
  status: string;
  internetBlocked?: boolean | null;
}): { label: string; color: string; soft: string } {
  if (!row.online) {
    if (row.internetBlocked) {
      return { label: "Blocked", color: "var(--red)", soft: "var(--red-soft)" };
    }
    return { label: "Offline", color: "var(--tx-3)", soft: "rgba(255,255,255,0.05)" };
  }
  if (row.status === "blocked" || row.internetBlocked) {
    return { label: "Blocked", color: "var(--red)", soft: "var(--red-soft)" };
  }
  if (row.status === "active") {
    return { label: "Active", color: "var(--gr)", soft: "var(--gr-soft)" };
  }
  if (row.status === "afk") {
    return { label: "AFK", color: "var(--amber)", soft: "var(--amber-soft)" };
  }
  return { label: "Online", color: "var(--gr)", soft: "var(--gr-soft)" };
}
