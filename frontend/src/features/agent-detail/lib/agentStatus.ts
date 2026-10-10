import type { Agent, AgentInfo, AgentLiveStatus } from "@/api/types";
import type { OsKind } from "@/components/common/OsBadge";

export type AgentAction = "restart-host" | "shutdown-host" | "lock-host" | "request-info" | "wake-lan";
export type AgentStatus = "connected" | "active" | "afk" | "offline";

export function formatUptime(secs?: number | null) {
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

export function osFromInfo(info: AgentInfo | null | undefined): OsKind {
  const os = `${info?.os_name ?? ""} ${info?.kernel_version ?? ""}`.toLowerCase();
  if (os.includes("windows")) return "windows";
  if (os.includes("darwin") || os.includes("mac")) return "macos";
  if (os.includes("docker")) return "docker";
  if (/linux|ubuntu|debian|fedora|cent\s?os|red\s?hat|rhel|arch|alpine|suse|mint|rocky|alma|gentoo|kali|manjaro|raspbian/.test(os))
    return "linux";
  return "unknown";
}

export function statusFor(agent: Agent, liveStatus?: AgentLiveStatus): { status: AgentStatus; label: string } {
  if (!agent.online) return { status: "offline", label: "Offline" };
  if (liveStatus?.activity === "afk") return { status: "afk", label: "AFK" };
  if (liveStatus?.activity === "active") return { status: "active", label: "Active now" };
  return { status: "connected", label: "Online" };
}

/** Status is carried by hue on the status word (plus a matching dot) — no pill badges. */
export function statusTone(status: AgentStatus): { text: string; dot: string } {
  if (status === "afk") return { text: "text-warning", dot: "var(--warning)" };
  if (status === "offline") return { text: "text-muted-foreground", dot: "var(--muted-foreground)" };
  return { text: "text-success", dot: "var(--success)" };
}
