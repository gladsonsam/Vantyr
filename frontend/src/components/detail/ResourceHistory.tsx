import { useEffect, useState } from "react";
import { Container, Header, Box, SpaceBetween, Spinner } from "../ui/console";
import { api } from "../../lib/api";
import type { AgentMetricPoint } from "../../lib/types";

const RANGES: { key: string; label: string; hours: number }[] = [
  { key: "1h", label: "1h", hours: 1 },
  { key: "6h", label: "6h", hours: 6 },
  { key: "24h", label: "24h", hours: 24 },
  { key: "7d", label: "7d", hours: 168 },
];

type SeriesKey = "cpu_pct" | "mem_pct" | "disk_pct";

const SERIES: { key: SeriesKey; label: string; sub: (p: AgentMetricPoint) => string }[] = [
  { key: "cpu_pct", label: "CPU", sub: () => "" },
  {
    key: "mem_pct",
    label: "Memory",
    sub: (p) => `${(p.mem_used_mb / 1024).toFixed(1)} / ${(p.mem_total_mb / 1024).toFixed(1)} GB`,
  },
  {
    key: "disk_pct",
    label: "Disk",
    sub: (p) => `${p.disk_used_gb.toFixed(0)} / ${p.disk_total_gb.toFixed(0)} GB`,
  },
];

/** Dependency-free area sparkline for a 0–100% series. */
function Sparkline({ values }: { values: number[] }) {
  const W = 600;
  const H = 70;
  const pad = 4;
  if (values.length < 2) {
    return (
      <Box color="text-body-secondary" padding="s">
        Not enough samples to chart yet.
      </Box>
    );
  }
  const n = values.length;
  const x = (i: number) => pad + (i / (n - 1)) * (W - pad * 2);
  const y = (v: number) => pad + (1 - Math.min(100, Math.max(0, v)) / 100) * (H - pad * 2);
  const line = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)},${(H - pad).toFixed(1)} L${x(0).toFixed(1)},${(
    H - pad
  ).toFixed(1)} Z`;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height: 70, display: "block" }}
      role="img"
      aria-hidden="true"
    >
      <path d={area} fill="var(--gr-soft, rgba(32,221,143,0.12))" />
      <path
        d={line}
        fill="none"
        stroke="var(--gr, #20dd8f)"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function RangePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div role="group" aria-label="Time range" style={{ display: "flex", gap: 4 }}>
      {RANGES.map((r) => {
        const active = value === r.key;
        return (
          <button
            key={r.key}
            type="button"
            onClick={() => onChange(r.key)}
            aria-pressed={active}
            style={{
              padding: "3px 10px",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 12,
              border: "1px solid var(--line, #2a2c30)",
              background: active ? "var(--gr-soft, rgba(32,221,143,0.12))" : "transparent",
              color: active ? "var(--gr, #20dd8f)" : "var(--tx-2, #9aa0aa)",
            }}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}

export function ResourceHistory({ agentId }: { agentId: string }) {
  const [rangeKey, setRangeKey] = useState("24h");
  const [points, setPoints] = useState<AgentMetricPoint[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const hours = RANGES.find((r) => r.key === rangeKey)?.hours ?? 24;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const fromIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    api
      .agentMetrics(agentId, fromIso)
      .then((res) => {
        if (!cancelled) setPoints(res.points ?? []);
      })
      .catch((e) => {
        if (!cancelled) {
          setError("Failed to load resource history");
          console.error(e);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, hours]);

  const latest = points && points.length ? points[points.length - 1] : null;

  return (
    <Container header={<Header variant="h2">Resource history</Header>}>
      <SpaceBetween size="l">
        <RangePicker value={rangeKey} onChange={setRangeKey} />
        {loading ? (
          <Box textAlign="center" padding="l">
            <Spinner />
          </Box>
        ) : error ? (
          <Box color="text-status-error" padding="s">
            {error}
          </Box>
        ) : !points || points.length === 0 ? (
          <Box color="text-body-secondary" textAlign="center" padding="l">
            No resource samples yet. The agent reports CPU, memory and disk about once a minute
            while it is online.
          </Box>
        ) : (
          <SpaceBetween size="l">
            {SERIES.map((s) => {
              const vals = points.map((p) => p[s.key]);
              const cur = latest ? latest[s.key] : 0;
              const peak = vals.reduce((m, v) => Math.max(m, v), 0);
              const subText = latest ? s.sub(latest) : "";
              return (
                <div key={s.key}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      marginBottom: 4,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{s.label}</span>
                    <span
                      style={{
                        fontVariantNumeric: "tabular-nums",
                        fontSize: 12,
                        color: "var(--tx-2, #9aa0aa)",
                      }}
                    >
                      {cur.toFixed(0)}%{subText ? ` · ${subText}` : ""} · peak {peak.toFixed(0)}%
                    </span>
                  </div>
                  <Sparkline values={vals} />
                </div>
              );
            })}
          </SpaceBetween>
        )}
      </SpaceBetween>
    </Container>
  );
}
