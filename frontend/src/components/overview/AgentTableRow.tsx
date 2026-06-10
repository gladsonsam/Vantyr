import clsx from "clsx";
import {
  MonitorPlay,
  MousePointer2,
  Clock,
  MoreHorizontal,
  ShieldAlert,
  AppWindow,
} from "lucide-react";
import { IconButton, OsBadge, StatusPill } from "../ui/console";
import type { FleetRow } from "./types";
import { formatUptime, formatLastSeen, normalizeVersion } from "./utils";

interface AgentTableRowProps {
  row: FleetRow;
  selectedIds: string[];
  toggleSelected: (id: string) => void;
  onSelectAgent: (agentId: string) => void;
  onOpenScreen: (agentId: string) => void;
  setPowerModal: (modal: { agentId: string } | null) => void;
}

export function AgentTableRow({
  row,
  selectedIds,
  toggleSelected,
  onSelectAgent,
  onOpenScreen,
  setPowerModal,
}: AgentTableRowProps) {
  return (
    <tr className={clsx(!row.online && "is-offline")}>
      <td className="is-select">
        <input
          type="checkbox"
          aria-label={`Select ${row.displayName}`}
          checked={selectedIds.includes(row.id)}
          onChange={() => toggleSelected(row.id)}
        />
      </td>
      <td className="is-agent">
        <button type="button" className="vantyr-fleet-agent" onClick={() => onSelectAgent(row.id)}>
          <OsBadge os={row.os} />
          <span className="vantyr-fleet-agent__copy">
            <span className="vantyr-fleet-agent__name sx-mono">{row.displayName}</span>
            <span className="vantyr-fleet-agent__meta sx-mono">
              {row.user} · {row.ip}
            </span>
          </span>
        </button>
      </td>
      <td>
        <StatusPill status={row.status} pulse={row.status === "active"}>
          {row.statusLabel}
        </StatusPill>
      </td>
      <td>
        {row.online ? (
          <div className="vantyr-fleet-activity">
            <span className="vantyr-fleet-activity__bar">
              <span style={{ width: `${row.status === "afk" ? 24 : 68}%` }} />
            </span>
            <span className="sx-mono">{row.status === "afk" ? formatUptime(row.idleSecs) : "Live"}</span>
          </div>
        ) : (
          <span className="vantyr-fleet-muted sx-mono">-</span>
        )}
      </td>
      <td>
        <div className="vantyr-fleet-version">
          <span className="sx-mono">{row.version ? `v${normalizeVersion(row.version)}` : "-"}</span>
          {row.updateNeeded ? <span className="vantyr-fleet-update">update</span> : null}
        </div>
      </td>
      <td>
        <span className="sx-mono">{row.online ? formatUptime(row.effectiveUptimeSecs) : formatLastSeen(row.last_seen)}</span>
      </td>
      <td className="is-window">
        <div className="vantyr-fleet-window">
          <AppWindow size={14} aria-hidden="true" />
          <span>{row.lastWindow}</span>
        </div>
        {row.internetBlocked || (row.appBlockEnabledCount ?? 0) > 0 ? (
          <div className="vantyr-fleet-blocks">
            {row.internetBlocked ? (
              <span title={row.internetBlockedSource ? `Blocked by: ${row.internetBlockedSource}` : "Internet blocked"}>
                <ShieldAlert size={12} /> Internet
              </span>
            ) : null}
            {(row.appBlockEnabledCount ?? 0) > 0 ? (
              <span title={row.appBlockExamples?.join(", ") || "App block rules enabled"}>
                <ShieldAlert size={12} /> {row.appBlockEnabledCount} apps
              </span>
            ) : null}
          </div>
        ) : null}
      </td>
      <td className="is-actions">
        <div className="vantyr-fleet-row-actions">
          <IconButton icon={MonitorPlay} label="Open live screen" accent disabled={!row.online} onClick={() => onOpenScreen(row.id)} />
          <IconButton icon={MousePointer2} label="Open remote control" accent disabled={!row.online} onClick={() => onSelectAgent(row.id)} />
          <IconButton icon={Clock} label="Open activity" onClick={() => onSelectAgent(row.id)} />
          <IconButton icon={MoreHorizontal} label="Power actions" onClick={() => setPowerModal({ agentId: row.id })} />
        </div>
      </td>
    </tr>
  );
}
