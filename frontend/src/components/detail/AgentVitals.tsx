import { useEffect, useState } from "react";
import type { Agent, AgentInfo, AgentLiveStatus } from "../../lib/types";
import { api } from "../../lib/api";
import { Gauge } from "../common/Metrics";

interface AgentVitalsProps {
  agent: Agent;
  info: AgentInfo | null;
  liveStatus?: AgentLiveStatus;
  uptimeText: string;
  lastSeenText: string;
  version: string;
  updateAvailable?: boolean;
}

function primaryIp(info: AgentInfo | null) {
  // Prefer IPv4 (no colons) over IPv6
  for (const adapter of info?.adapters ?? []) {
    const ip = adapter.ips?.find((c) => c && !c.startsWith("127.") && c !== "::1" && !c.includes(":"));
    if (ip) return ip;
  }
  // Fallback to any non-loopback address
  for (const adapter of info?.adapters ?? []) {
    const ip = adapter.ips?.find((c) => c && !c.startsWith("127.") && c !== "::1");
    if (ip) return ip;
  }
  return "—";
}

function memoryParts(info: AgentInfo | null) {
  const total = info?.memory_total_mb;
  const used = info?.memory_used_mb;
  if (!total) return { pct: 0, text: "—" };
  const pct = used ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const usedGb = used ? Math.round(used / 1024) : 0;
  const totalGb = Math.round(total / 1024);
  return { pct, text: `${usedGb} / ${totalGb} GB` };
}

export function AgentVitals({
  agent,
  info,
  liveStatus,
  uptimeText,
  lastSeenText,
  version,
  updateAvailable = false,
}: AgentVitalsProps) {
  const online = agent.online;
  const [internetBlocked, setInternetBlocked] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .agentInternetBlockedGet(agent.id)
      .then((res) => {
        if (!cancelled) setInternetBlocked(Boolean(res.blocked));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  const mem = memoryParts(info);
  const activity = liveStatus?.activity;
  const sessionTone = online ? "var(--gr)" : "var(--tx-3)";
  const sessionLabel = !online ? "Ended" : activity === "afk" ? "Idle" : "Active";

  const rows: Array<{ label: string; value: string; color: string }> = [
    { label: "Session", value: sessionLabel, color: sessionTone },
    { label: online ? "Uptime" : "Last seen", value: online ? uptimeText : lastSeenText, color: "var(--tx)" },
    { label: "Memory", value: mem.text, color: "var(--tx)" },
    { label: "CPU", value: info?.cpu_cores ? `${info.cpu_cores} cores` : info?.cpu_brand?.split(" ").slice(0, 2).join(" ") || "—", color: "var(--tx)" },
    { label: "Agent version", value: `v${version}`, color: updateAvailable ? "var(--amber)" : "var(--tx)" },
    { label: "IP address", value: primaryIp(info), color: "var(--tx)" },
    {
      label: "Internet",
      value: internetBlocked == null ? "—" : internetBlocked ? "Blocked" : "Allowed",
      color: internetBlocked ? "var(--red)" : internetBlocked === false ? "var(--gr)" : "var(--tx-3)",
    },
  ];

  return (
    <div
      style={{
        width: 300,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r)",
        padding: 20,
        boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
      }}
    >
      {/* Gauge + headline metric */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, paddingBottom: 16, borderBottom: "1px solid var(--line)" }}>
        {online ? (
          <Gauge value={mem.pct} size={86} color="var(--gr)" label="MEM" big />
        ) : (
          <div
            style={{
              width: 86,
              height: 86,
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
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, color: "var(--tx-3)", fontWeight: 600, marginBottom: 4 }}>Memory load</div>
          <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "var(--display)", color: "var(--tx)", letterSpacing: "-0.01em" }}>
            {mem.text}
          </div>
          {info?.cpu_brand && (
            <div
              style={{
                fontSize: 11,
                color: "var(--tx-3)",
                marginTop: 4,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 170,
              }}
              title={info.cpu_brand}
            >
              {info.cpu_brand}
            </div>
          )}
        </div>
      </div>

      {/* Vitals rows */}
      <div style={{ display: "flex", flexDirection: "column", paddingTop: 6 }}>
        {rows.map((row, i) => (
          <div
            key={row.label}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "9px 0",
              borderBottom: i < rows.length - 1 ? "1px solid var(--line)" : "none",
            }}
          >
            <span style={{ fontSize: 12.5, color: "var(--tx-2)", fontWeight: 500, flexShrink: 0 }}>{row.label}</span>
            <span
              style={{ fontSize: 12.5, color: row.color, fontWeight: 600, fontFamily: "var(--mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right" }}
              title={row.value}
            >{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
