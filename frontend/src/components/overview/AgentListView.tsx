import { useState } from "react";
import type { FleetRow } from "./types";
import { fleetState, formatUptime, formatLastSeen, normalizeVersion } from "./utils";
import { Dot } from "../common/Metrics";
import { OsBadge } from "../ui/console";
import { VI } from "../common/Icons";

interface AgentListViewProps {
  filteredRows: FleetRow[];
  onSelectAgent: (agentId: string) => void;
  onOpenScreen: (agentId: string) => void;
  setPowerModal: (modal: { agentId: string } | null) => void;
  latestAgentVersion?: string | null;
}

const COL = {
  agent: 248,
  status: 104,
  uptime: 120,
  version: 120,
  actions: 118,
};

const headStyle: React.CSSProperties = {
  fontSize: 10,
  color: "var(--tx-4)",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
};

function AgentRow({
  row,
  onSelectAgent,
  onOpenScreen,
  setPowerModal,
  latestAgentVersion,
}: {
  row: FleetRow;
  onSelectAgent: (agentId: string) => void;
  onOpenScreen: (agentId: string) => void;
  setPowerModal: (modal: { agentId: string } | null) => void;
  latestAgentVersion?: string | null;
}) {
  const online = row.online;
  const st = fleetState(row);
  const [hover, setHover] = useState(false);

  return (
    <div
      onClick={() => onSelectAgent(row.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "13px 18px",
        borderRadius: 12,
        cursor: "pointer",
        background: hover ? "var(--card)" : "transparent",
        border: `1px solid ${hover ? "var(--line-2)" : "transparent"}`,
        opacity: online ? 1 : 0.6,
        transition: "background .12s",
      }}
    >
      {/* identity */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, width: COL.agent, flexShrink: 0, minWidth: 0 }}>
        <OsBadge os={row.os} size={36} />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
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
            {row.user} · {row.ip}
          </div>
        </div>
      </div>

      {/* status */}
      <div style={{ width: COL.status, flexShrink: 0 }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            borderRadius: 99,
            background: st.soft,
          }}
        >
          <Dot color={st.color} size={6} halo={false} />
          <span style={{ fontSize: 11, fontWeight: 600, color: st.color }}>{st.label}</span>
        </div>
      </div>

      {/* last window */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <VI.window style={{ width: 14, height: 14, color: "var(--tx-3)", flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 12.5,
                fontWeight: 500,
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
        </div>
      </div>

      {/* uptime */}
      <div style={{ width: COL.uptime, flexShrink: 0 }}>
        <div style={{ fontSize: 12.5, color: online ? "var(--tx)" : "var(--tx-3)", fontWeight: 600, fontFamily: "var(--mono)" }}>
          {online ? formatUptime(row.effectiveUptimeSecs) : formatLastSeen(row.last_seen)}
        </div>
      </div>

      {/* version */}
      <div style={{ width: COL.version, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontSize: 12.5, color: "var(--tx)", fontWeight: 600, fontFamily: "var(--mono)" }}>
            {row.version ? `v${normalizeVersion(row.version)}` : "-"}
          </span>
          {row.updateNeeded && <VI.warn style={{ width: 13, height: 13, color: "var(--amber)" }} />}
          {row.internetBlocked && <VI.lock style={{ width: 13, height: 13, color: "var(--red)" }} />}
        </div>
        {row.updateNeeded && latestAgentVersion && (
          <div style={{ fontSize: 10.5, color: "var(--amber)", marginTop: 2, fontFamily: "var(--mono)" }}>update ready</div>
        )}
      </div>

      {/* actions */}
      <div style={{ width: COL.actions, flexShrink: 0, display: "flex", gap: 6, justifyContent: "flex-end" }}>
        {[
          { icon: VI.play, onClick: () => online && onOpenScreen(row.id), primary: true },
          { icon: VI.ctrl, onClick: () => online && onSelectAgent(row.id), primary: false },
          { icon: VI.more, onClick: () => setPowerModal({ agentId: row.id }), primary: false },
        ].map((act, i) => {
          const greenHover = act.primary && hover && online;
          return (
            <div
              key={i}
              onClick={(e) => {
                e.stopPropagation();
                act.onClick();
              }}
              style={{
                width: 30,
                height: 30,
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: online || !act.primary ? "pointer" : "not-allowed",
                opacity: act.primary && !online ? 0.35 : 1,
                background: greenHover ? "var(--gr)" : "var(--card-2)",
                color: greenHover ? "#06251a" : "var(--tx-2)",
                border: "1px solid var(--line-2)",
                transition: "background .12s",
              }}
            >
              <act.icon style={{ width: 14, height: 14 }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AgentListView({
  filteredRows,
  onSelectAgent,
  onOpenScreen,
  setPowerModal,
  latestAgentVersion,
}: AgentListViewProps) {
  return (
    <div style={{ padding: "16px 24px 24px" }}>
      <div
        style={{
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r)",
          padding: 8,
          boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* column header */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "6px 18px 10px" }}>
          <div style={{ width: COL.agent, flexShrink: 0, ...headStyle }}>Agent</div>
          <div style={{ width: COL.status, flexShrink: 0, ...headStyle }}>Status</div>
          <div style={{ flex: 1, ...headStyle }}>Current window</div>
          <div style={{ width: COL.uptime, flexShrink: 0, ...headStyle }}>Uptime</div>
          <div style={{ width: COL.version, flexShrink: 0, ...headStyle }}>Version</div>
          <div style={{ width: COL.actions, flexShrink: 0 }} />
        </div>
        <div style={{ height: 1, background: "var(--line)", margin: "0 10px 6px" }} />

        {filteredRows.map((row, i) => (
          <div key={row.id}>
            <AgentRow
              row={row}
              onSelectAgent={onSelectAgent}
              onOpenScreen={onOpenScreen}
              setPowerModal={setPowerModal}
              latestAgentVersion={latestAgentVersion}
            />
            {i < filteredRows.length - 1 && (
              <div style={{ height: 1, background: "var(--line)", margin: "3px 18px" }} />
            )}
          </div>
        ))}

        {filteredRows.length === 0 && (
          <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--tx-3)", fontSize: 13 }}>
            No matching agents
          </div>
        )}
      </div>
    </div>
  );
}
