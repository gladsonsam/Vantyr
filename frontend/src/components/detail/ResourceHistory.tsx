import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Spinner } from "@/components/ui/spinner";
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
      <div className="p-2 text-sm text-muted-foreground">
        Not enough samples to chart yet.
      </div>
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
    <span className="block text-success">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-[70px] w-full"
        role="img"
        aria-hidden="true"
      >
        <path d={area} fill="currentColor" opacity={0.12} />
        <path
          d={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </span>
  );
}

function RangePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <ToggleGroup
      size="sm"
      aria-label="Time range"
      value={[value]}
      onValueChange={(next) => {
        if (next[0]) onChange(next[0]);
      }}
    >
      {RANGES.map((r) => (
        <ToggleGroupItem key={r.key} value={r.key} aria-label={`${r.label} range`}>
          {r.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
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
          setError("Couldn't load history.");
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
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle>Resource history</CardTitle>
        <RangePicker value={rangeKey} onChange={setRangeKey} />
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : !points || points.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No samples yet.
          </div>
        ) : (
          SERIES.map((s) => {
            const vals = points.map((p) => p[s.key]);
            const cur = latest ? latest[s.key] : 0;
            const peak = vals.reduce((m, v) => Math.max(m, v), 0);
            const subText = latest ? s.sub(latest) : "";
            return (
              <div key={s.key}>
                <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="font-semibold">{s.label}</span>
                  <span className="text-xs text-muted-foreground tabular-nums break-words">
                    {cur.toFixed(0)}%{subText ? ` · ${subText}` : ""} · peak {peak.toFixed(0)}%
                  </span>
                </div>
                <Sparkline values={vals} />
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
