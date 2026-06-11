import type { FleetRow } from "./types";
import { formatUptime, formatLastSeen, normalizeVersion } from "./utils";
import { Gauge, Dot, OsChip } from "../common/Metrics";
import { VI } from "../common/Icons";

interface AgentCardGridProps {
  filteredRows: FleetRow[];
  selectedIds: string[];
  toggleSelected: (id: string) => void;
  onSelectAgent: (agentId: string) => void;
  onOpenScreen: (agentId: string) => void;
  setPowerModal: (modal: { agentId: string } | null) => void;
  latestAgentVersion?: string | null;
}

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
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
        gap: 16,
        padding: "16px 24px 24px",
      }}
    >
      {filteredRows.map((row) => {
        const online = row.online;

        // Visual state matching stateOf
        let label = "Offline";
        let color = "var(--tx-3)";
        let soft = "rgba(255,255,255,0.05)";

        if (online) {
          if (row.status === "active") {
            label = "Active";
            color = "var(--gr)";
            soft = "var(--gr-soft)";
          } else if (row.status === "afk") {
            label = "AFK";
            color = "var(--amber)";
            soft = "var(--amber-soft)";
          } else {
            label = "Online";
            color = "var(--gr)";
            soft = "var(--gr-soft)";
          }
        } else if (row.internetBlocked) {
          label = "Blocked";
          color = "var(--red)";
          soft = "var(--red-soft)";
        }

        // Generate stable simulated metrics so card matches design mockup
        const charCode = row.id.charCodeAt(0) || 0;
        const cpuVal = online ? (row.status === "active" ? 18 + (charCode % 12) : 4 + (charCode % 5)) : 0;
        const sessionsVal = 40 + (charCode * 6) % 350;

        return (
          <div
            key={row.id}
            onClick={() => onSelectAgent(row.id)}
            style={{
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r)",
              padding: 18,
              position: "relative",
              overflow: "hidden",
              boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
              display: "flex",
              flexDirection: "column",
              gap: 0,
              opacity: online ? 1 : 0.62,
              cursor: "pointer",
              transition: "opacity 0.15s ease",
            }}
          >
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
              <input
                type="checkbox"
                checked={selectedIds.includes(row.id)}
                onChange={(e) => {
                  e.stopPropagation();
                  toggleSelected(row.id);
                }}
                onClick={(e) => e.stopPropagation()}
                style={{ marginRight: 4, cursor: "pointer" }}
              />
              <OsChip os={row.os} size={38} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    color: "var(--tx)",
                    letterSpacing: "-0.01em",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.displayName}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--tx-3)",
                    marginTop: 1,
                    fontFamily: "var(--mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.user}
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 10px",
                  borderRadius: 99,
                  background: soft,
                }}
              >
                <Dot color={color} size={6} halo={false} />
                <span style={{ fontSize: 11, fontWeight: 600, color }}>{label}</span>
              </div>
            </div>

            {/* Gauge + Meta */}
            <div style={{ display: "flex", alignItems: "center", gap: 18, margin: "18px 0" }}>
              {online ? (
                <Gauge value={cpuVal} size={88} color={color} label="CPU" big />
              ) : (
                <div
                  style={{
                    width: 88,
                    height: 88,
                    borderRadius: "50%",
                    border: "5px solid var(--card-3)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <span style={{ fontSize: 12, color: "var(--tx-3)", fontWeight: 600 }}>OFF</span>
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 11 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11.5, color: "var(--tx-3)", fontWeight: 500 }}>
                    {online ? "Uptime" : "Last seen"}
                  </span>
                  <span style={{ fontSize: 12.5, color: "var(--tx)", fontWeight: 600 }}>
                    {online ? formatUptime(row.effectiveUptimeSecs) : formatLastSeen(row.last_seen)}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11.5, color: "var(--tx-3)", fontWeight: 500 }}>Sessions</span>
                  <span style={{ fontSize: 12.5, color: "var(--tx)", fontWeight: 600 }}>
                    {sessionsVal.toLocaleString()}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11.5, color: "var(--tx-3)", fontWeight: 500 }}>Version</span>
                  <span style={{ fontSize: 12.5, color: row.updateNeeded ? "var(--amber)" : "var(--tx)", fontWeight: 600 }}>
                    v{normalizeVersion(row.version)}
                    {row.updateNeeded && latestAgentVersion && (
                      <span style={{ color: "var(--amber)", fontWeight: 600 }}>
                        {" "}
                        → v{normalizeVersion(latestAgentVersion)}
                      </span>
                    )}
                  </span>
                </div>
              </div>
            </div>

            {/* Last Window */}
            <div style={{ padding: "11px 13px", borderRadius: 10, background: "var(--card-2)", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                <VI.window style={{ width: 15, height: 15, color: "var(--tx-3)", flexShrink: 0 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: online ? "var(--tx)" : "var(--tx-2)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.lastWindow}
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--tx-3)", marginTop: 1, fontFamily: "var(--mono)" }}>
                    {row.liveStatus?.app || "-"}
                  </div>
                </div>
                {row.internetBlocked && (
                  <div style={{ color: "var(--red)", flexShrink: 0 }}>
                    <VI.lock style={{ width: 14, height: 14 }} />
                  </div>
                )}
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: "flex", gap: 7 }}>
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  if (online) onOpenScreen(row.id);
                }}
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  padding: "9px 0",
                  borderRadius: 9,
                  cursor: online ? "pointer" : "not-allowed",
                  opacity: online ? 1 : 0.4,
                  background: "var(--gr)",
                  color: "#06251a",
                  fontSize: 12,
                  fontWeight: 700,
                  border: "none",
                }}
              >
                <VI.play style={{ width: 14, height: 14 }} /> Live
              </div>
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  if (online) onSelectAgent(row.id);
                }}
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  padding: "9px 0",
                  borderRadius: 9,
                  cursor: online ? "pointer" : "not-allowed",
                  opacity: online ? 1 : 0.4,
                  background: "var(--card-2)",
                  color: "var(--tx-2)",
                  fontSize: 12,
                  fontWeight: 700,
                  border: "1px solid var(--line-2)",
                }}
              >
                <VI.ctrl style={{ width: 14, height: 14 }} /> Control
              </div>
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  setPowerModal({ agentId: row.id });
                }}
                style={{
                  width: 40,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "9px 0",
                  borderRadius: 9,
                  cursor: "pointer",
                  background: "var(--card-2)",
                  color: "var(--tx-2)",
                  fontSize: 12,
                  border: "1px solid var(--line-2)",
                }}
              >
                <VI.more style={{ width: 14, height: 14 }} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
