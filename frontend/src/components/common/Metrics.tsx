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

