import { Clock, Cpu, MemoryStick, Network } from "lucide-react";
import type { Agent, AgentInfo, AgentLiveStatus } from "../../lib/types";

interface AgentQuickStatsProps {
  agent: Agent;
  info: AgentInfo | null;
  liveStatus?: AgentLiveStatus;
  uptimeText: string;
  lastSeenText: string;
}

function fmtMemory(info: AgentInfo | null) {
  if (!info?.memory_total_mb) return "-";
  const used = info.memory_used_mb ? `${Math.round(info.memory_used_mb / 1024)} GB` : "?";
  return `${used} / ${Math.round(info.memory_total_mb / 1024)} GB`;
}

function primaryIp(info: AgentInfo | null) {
  for (const adapter of info?.adapters ?? []) {
    const ip = adapter.ips?.find((candidate) => candidate && !candidate.startsWith("127.") && candidate !== "::1");
    if (ip) return ip;
  }
  return "-";
}

export function AgentQuickStats({ agent, info, liveStatus, uptimeText, lastSeenText }: AgentQuickStatsProps) {
  const stats = [
    { label: agent.online ? "Uptime" : "Last seen", value: agent.online ? uptimeText : lastSeenText, icon: Clock },
    { label: "Activity", value: agent.online ? liveStatus?.activity ?? "connected" : "offline", icon: Cpu },
    { label: "Memory", value: fmtMemory(info), icon: MemoryStick },
    { label: "Network", value: primaryIp(info), icon: Network },
  ];

  return (
    <div className="sentinel-agent-quick-stats sx-console">
      {stats.map((stat) => {
        const Icon = stat.icon;
        return (
          <div key={stat.label} className="sentinel-agent-quick-stat">
            <div className="sentinel-agent-quick-stat__label">
              <Icon size={14} aria-hidden="true" />
              <span>{stat.label}</span>
            </div>
            <div className="sentinel-agent-quick-stat__value sx-mono">{stat.value}</div>
          </div>
        );
      })}
    </div>
  );
}
