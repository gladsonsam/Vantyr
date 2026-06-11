import clsx from "clsx";
import {
  MonitorPlay,
  MousePointer2,
  Clock,
  MoreHorizontal,
  ShieldAlert,
  AppWindow,
  Search,
} from "lucide-react";
import { IconButton, OsBadge, type ConsoleStatus } from "../ui/console";
import type { FleetRow } from "./types";
import { formatUptime, formatLastSeen, normalizeVersion } from "./utils";

interface AgentCardGridProps {
  filteredRows: FleetRow[];
  selectedIds: string[];
  toggleSelected: (id: string) => void;
  onSelectAgent: (agentId: string) => void;
  onOpenScreen: (agentId: string) => void;
  setPowerModal: (modal: { agentId: string } | null) => void;
  latestAgentVersion?: string | null;
}

const getStatusDotColor = (status: ConsoleStatus) => {
  switch (status) {
    case "active":
      return "var(--sx-success, #10b981)";
    case "connected":
    case "ok":
      return "var(--sx-accent, #3b82f6)";
    case "afk":
      return "var(--sx-warning, #f59e0b)";
    case "blocked":
    case "danger":
      return "var(--sx-danger, #ef4444)";
    case "offline":
    default:
      return "var(--sx-text-muted, #6b7280)";
  }
};

export function AgentCardGrid({
  filteredRows,
  selectedIds,
  toggleSelected,
  onSelectAgent,
  onOpenScreen,
  setPowerModal,
  latestAgentVersion,
}: AgentCardGridProps) {
  return (
    <div className="vantyr-fleet-grid">
      {filteredRows.map((row) => (
        <div key={row.id} className={clsx("vantyr-fleet-card", !row.online && "is-offline")} style={{
          borderRadius: 'var(--sx-radius-lg, 12px)',
          border: '1px solid var(--sx-border, #262930)',
          background: 'var(--sx-surface, #131418)',
          padding: '16px',
          boxShadow: 'var(--sx-shadow, 0 4px 20px rgba(0,0,0,0.15))',
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
          position: 'relative',
          opacity: row.online ? 1 : 0.55,
          transition: 'border-color 0.15s ease, background-color 0.15s ease, opacity 0.15s ease',
        }}>
          {/* head */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="checkbox"
              aria-label={`Select ${row.displayName}`}
              checked={selectedIds.includes(row.id)}
              onChange={() => toggleSelected(row.id)}
              style={{ marginRight: -2 }}
            />
            <OsBadge os={row.os} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button type="button" className="vantyr-fleet-card__name sx-mono" onClick={() => onSelectAgent(row.id)} style={{
                  fontSize: '15px', fontWeight: 800, letterSpacing: '-0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  background: 'none', border: 'none', padding: 0, color: 'var(--sx-text, #eceef1)', cursor: 'pointer', textAlign: 'left', width: '100%'
                }}>
                  {row.displayName}
                </button>
                {row.updateNeeded && (
                  <span title="Update available" style={{ color: 'var(--sx-warning, #f59e0b)', display: 'flex', flexShrink: 0 }}>
                    <ShieldAlert size={14} />
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 4 }}>
                <div style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: getStatusDotColor(row.status)
                }} />
                <span style={{ fontSize: '12px', fontWeight: 600, color: row.status === 'offline' ? 'var(--sx-text-muted, #6b7280)' : 'var(--sx-text, #eceef1)', whiteSpace: 'nowrap' }}>
                  {row.statusLabel}
                </span>
              </div>
            </div>
            {/* User & IP badge */}
            <div className="sx-mono" style={{ fontSize: '11px', color: 'var(--sx-text-dim, #7a7e85)', textAlign: 'right', flexShrink: 0 }}>
              <div>{row.user}</div>
              <div>{row.ip}</div>
            </div>
          </div>

          {/* meta grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '11px 14px' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '11px', color: 'var(--sx-text-dim, #7a7e85)', fontWeight: 500, marginBottom: 3 }}>Version</div>
              <div className="sx-mono" style={{ fontSize: '12.5px', color: 'var(--sx-text, #eceef1)', fontWeight: 500 }}>
                {row.version ? `v${normalizeVersion(row.version)}` : "-"}
                {row.updateNeeded && latestAgentVersion && (
                  <span style={{ color: 'var(--sx-warning, #f59e0b)' }}> → v{normalizeVersion(latestAgentVersion)}</span>
                )}
              </div>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '11px', color: 'var(--sx-text-dim, #7a7e85)', fontWeight: 500, marginBottom: 3 }}>
                {row.online ? 'Uptime' : 'Last seen'}
              </div>
              <div className="sx-mono" style={{ fontSize: '12.5px', color: 'var(--sx-text, #eceef1)', fontWeight: 500 }}>
                {row.online ? formatUptime(row.effectiveUptimeSecs) : formatLastSeen(row.last_seen)}
              </div>
            </div>
            <div style={{ gridColumn: '1 / -1', minWidth: 0 }}>
              <div style={{ fontSize: '11px', color: 'var(--sx-text-dim, #7a7e85)', fontWeight: 500, marginBottom: 3 }}>Last window</div>
              <div style={{ fontSize: '12.5px', color: 'var(--sx-text, #eceef1)', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                <AppWindow size={14} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--sx-text-dim, #7a7e85)' }} />
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }} title={row.lastWindow}>
                  {row.lastWindow}
                </span>
              </div>
            </div>
          </div>

          {/* blocks if any */}
          {(row.internetBlocked || (row.appBlockEnabledCount ?? 0) > 0) && (
            <div style={{ display: 'flex', gap: 8, padding: '4px 8px', borderRadius: '4px', background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.1)', marginTop: -4 }}>
              {row.internetBlocked && (
                <span title={row.internetBlockedSource ? `Blocked by: ${row.internetBlockedSource}` : "Internet blocked"} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '11px', color: 'var(--sx-danger, #ef4444)' }}>
                  <ShieldAlert size={12} /> Internet Blocked
                </span>
              )}
              {(row.appBlockEnabledCount ?? 0) > 0 && (
                <span title={row.appBlockExamples?.join(", ") || "App block rules enabled"} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '11px', color: 'var(--sx-danger, #ef4444)' }}>
                  <ShieldAlert size={12} /> {row.appBlockEnabledCount} App Block{row.appBlockEnabledCount === 1 ? '' : 's'}
                </span>
              )}
            </div>
          )}

          {/* action row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 13, borderTop: '1px solid var(--sx-border, #262930)', marginTop: 'auto' }}>
            <span className="sx-mono" style={{ fontSize: '11.5px', color: 'var(--sx-text-dim, #7a7e85)' }}>
              {row.online ? (row.status === "afk" ? `${formatUptime(row.idleSecs)} idle` : "Live") : "—"}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <IconButton icon={MonitorPlay} label="Open live screen" accent disabled={!row.online} onClick={() => onOpenScreen(row.id)} />
              <IconButton icon={MousePointer2} label="Open remote control" accent disabled={!row.online} onClick={() => onSelectAgent(row.id)} />
              <IconButton icon={Clock} label="Open activity" onClick={() => onSelectAgent(row.id)} />
              <IconButton icon={MoreHorizontal} label="Power actions" onClick={() => setPowerModal({ agentId: row.id })} />
            </div>
          </div>
        </div>
      ))}

      {filteredRows.length === 0 ? (
        <div className="vantyr-fleet-empty" style={{ gridColumn: "1 / -1" }}>
          <Search size={18} aria-hidden="true" />
          <strong>No matching agents</strong>
          <span>Clear search or status filters to return to the full fleet.</span>
        </div>
      ) : null}
    </div>
  );
}
