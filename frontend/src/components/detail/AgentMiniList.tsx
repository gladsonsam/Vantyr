import { useMemo, useState } from "react";
import clsx from "clsx";
import type { Agent, AgentInfo, AgentLiveStatus } from "../../lib/types";
import { OsBadge, SearchField, StatusDot, type ConsoleStatus, type OsKind } from "../ui/console";

interface AgentMiniListProps {
  agents: Record<string, Agent>;
  agentInfo: Record<string, AgentInfo | null>;
  liveStatus: Record<string, AgentLiveStatus>;
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
}

function osFromInfo(info: AgentInfo | null | undefined): OsKind {
  const os = `${info?.os_name ?? ""} ${info?.kernel_version ?? ""}`.toLowerCase();
  if (os.includes("windows")) return "windows";
  if (os.includes("darwin") || os.includes("mac")) return "macos";
  if (os.includes("docker")) return "docker";
  if (os.includes("linux")) return "linux";
  return "unknown";
}

function rowStatus(agent: Agent, status?: AgentLiveStatus): ConsoleStatus {
  if (!agent.online) return "offline";
  if (status?.activity === "afk") return "afk";
  if (status?.activity === "active") return "active";
  return "connected";
}

export function AgentMiniList({
  agents,
  agentInfo,
  liveStatus,
  selectedAgentId,
  onSelectAgent,
}: AgentMiniListProps) {
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return Object.values(agents)
      .filter((agent) => {
        if (!needle) return true;
        const info = agentInfo[agent.id];
        const status = liveStatus[agent.id];
        return [agent.name, agent.id, info?.hostname, info?.current_user, status?.window]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle));
      })
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }, [agentInfo, agents, liveStatus, query]);

  const connected = rows.filter((agent) => agent.online);
  const offline = rows.filter((agent) => !agent.online);

  const renderRow = (agent: Agent) => {
    const info = agentInfo[agent.id];
    const status = liveStatus[agent.id];
    const selected = agent.id === selectedAgentId;
    const currentStatus = rowStatus(agent, status);
    const lastLine = status?.window || info?.current_user || (agent.online ? "Connected" : "Offline");

    return (
      <button
        key={agent.id}
        type="button"
        className={clsx("sentinel-agent-mini-row", selected && "is-selected")}
        onClick={() => onSelectAgent(agent.id)}
      >
        <OsBadge os={osFromInfo(info)} />
        <span className="sentinel-agent-mini-row__copy">
          <span className="sentinel-agent-mini-row__name sx-mono">{agent.name}</span>
          <span className="sentinel-agent-mini-row__meta">{lastLine}</span>
        </span>
        <StatusDot status={currentStatus} pulse={currentStatus === "active"} />
      </button>
    );
  };

  return (
    <aside className="sentinel-agent-mini-list sx-console">
      <div className="sentinel-agent-mini-list__head">
        <div className="sentinel-agent-mini-list__title">
          Agents <span className="sx-mono">{Object.keys(agents).length}</span>
        </div>
        <div className="sentinel-agent-mini-list__live">
          <StatusDot status="connected" />
          <span>{Object.values(agents).filter((agent) => agent.online).length} live</span>
        </div>
        <SearchField
          label="Search agents"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search fleet..."
          containerClassName="sentinel-agent-mini-list__search"
        />
      </div>

      <div className="sentinel-agent-mini-list__body">
        <div className="sentinel-agent-mini-list__group">Connected · {connected.length}</div>
        {connected.map(renderRow)}
        <div className="sentinel-agent-mini-list__group">Offline · {offline.length}</div>
        {offline.map(renderRow)}
      </div>
    </aside>
  );
}
