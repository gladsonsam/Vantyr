import React from "react";

interface GaugeProps {
  value: number;
  max?: number;
  size?: number;
  stroke?: number;
  color?: string;
  label?: string;
  big?: boolean;
}

export function Gauge({
  value,
  max = 100,
  size = 84,
  stroke = 5,
  color = "var(--blue)",
  label,
  big,
}: GaugeProps) {
  const r = (size - stroke) / 2 - 1;
  const cx = size / 2;
  const cy = size / 2;
  const C = 2 * Math.PI * r;
  const sweep = 0.72; // 260°-ish arc
  const trackLen = C * sweep;
  const valLen = trackLen * Math.min(Math.max(value / max, 0), 1);
  const rot = 90 + (1 - sweep) * 180; // open at the bottom

  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ display: "block", transform: `rotate(${rot}deg)` }}
      >
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="var(--card-3)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${trackLen} ${C}`}
        />
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${valLen} ${C}`}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span
          style={{
            fontSize: Math.round(size * (big ? 0.3 : 0.34)),
            fontWeight: 700,
            fontFamily: "var(--display)",
            color: "var(--tx)",
            letterSpacing: "-0.02em",
            lineHeight: 1,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {value}
          <span style={{ fontSize: Math.round(size * 0.16), color: "var(--tx-3)", fontWeight: 600, marginLeft: "1.5px" }}>
            {max === 100 ? "%" : ""}
          </span>
        </span>
        {label && size >= 70 && (
          <span
            style={{
              fontSize: 9.5,
              color: "var(--tx-3)",
              fontWeight: 600,
              marginTop: 2,
              letterSpacing: "0.02em",
            }}
          >
            {label}
          </span>
        )}
      </div>
    </div>
  );
}

interface DotProps {
  color: string;
  size?: number;
  halo?: boolean;
}

export function Dot({ color, size = 8, halo = false }: DotProps) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        boxShadow: halo
          ? `0 0 0 3px color-mix(in srgb, ${color} 18%, transparent)`
          : "none",
      }}
    />
  );
}

interface OsChipProps {
  os: "win" | "mac" | "lnx" | "dkr" | string;
  size?: number;
}

const osColor: Record<string, string> = {
  win: "#6fb1ff",
  mac: "#c8cdd5",
  lnx: "#f1b24a",
  dkr: "#5fa9e8",
};

export function OsChip({ os, size = 34 }: OsChipProps) {
  const normOs = os.toLowerCase().includes("win")
    ? "win"
    : os.toLowerCase().includes("mac") || os.toLowerCase().includes("apple")
      ? "mac"
      : os.toLowerCase().includes("linux") || os.toLowerCase().includes("lnx")
        ? "lnx"
        : "dkr";

  const icons: Record<string, (p: React.SVGProps<SVGSVGElement>) => React.ReactNode> = {
    win: (p) => (
      <svg
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        {...p}
      >
        <path d="M2 4l6-1.5v7.5H2V4zm0 8h6v7.5L2 16V12zm8-9l8-1.5v8.5h-8V3zm0 9.5h8V16l-8 1.5V12.5z" />
      </svg>
    ),
    mac: (p) => (
      <svg
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        {...p}
      >
        <rect x="2.5" y="3" width="15" height="12" rx="1.5" />
        <path d="M5.5 15h9M7.5 17h5" />
      </svg>
    ),
    lnx: (p) => (
      <svg viewBox="0 0 20 20" fill="currentColor" {...p}>
        <path d="M10 2c-1.2 0-1.5 1-1.5 2.5 0 .8-.3 1.2-.8 1.2-.5 0-.7-.4-.7-1.2 0-3 1.8-4.5 3-4.5 1.2 0 3 1.5 3 4.5 0 .8-.2 1.2-.7 1.2-.5 0-.8-.4-.8-1.2C11.5 3 11.2 2 10 2zm-2.2 6c-.6 0-1 .4-1 1v5.5c0 .6.4 1 1 1 .5 0 1-.4 1-1V9c0-.6-.4-1-1-1zm4.4 0c-.6 0-1 .4-1 1v5.5c0 .6.4 1 1 1 .5 0 1-.4 1-1V9c0-.6-.4-1-1-1zm-2.2 8c-1 .5-2 .8-2 1.5 0 .8.6 1.5 2 1.5s2-.7 2-1.5c0-.7-1-1-2-1.5z" />
      </svg>
    ),
    dkr: (p) => (
      <svg viewBox="0 0 20 20" fill="currentColor" {...p}>
        <path d="M6.5 5h2v2h-2V5zm3.5 0h2v2h-2V5zm3.5 0h2v2h-2V5zM6.5 9h2v2h-2V9zm3.5 0h2v2h-2V9zm3.5 0h2v2h-2V9zM6.5 13h2v2h-2v-2zm3.5 0h2v2h-2v-2zm3.5 0h2v2h-2v-2z" />
      </svg>
    ),
  };

  const Icon = icons[normOs];
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.32,
        background: "var(--card-2)",
        border: "1px solid var(--line-2)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: osColor[normOs] || "var(--tx-2)",
      }}
    >
      {Icon && <Icon style={{ width: size * 0.55, height: size * 0.55 }} />}
    </div>
  );
}
