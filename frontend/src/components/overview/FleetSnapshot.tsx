import { Gauge } from "../common/Metrics";

interface FleetSnapshotItem {
  label: string;
  value: number;
  meta: string;
  tone: "connected" | "active" | "afk" | "offline" | "danger";
}

interface FleetSnapshotProps {
  items: FleetSnapshotItem[];
  total: number;
}

export function FleetSnapshot({ items, total }: FleetSnapshotProps) {
  const toneColorMap = {
    connected: "var(--gr)",
    active: "var(--blue)",
    afk: "var(--amber)",
    offline: "var(--tx-3)",
    danger: "var(--red)",
  };

  return (
    <div
      style={{
        display: "flex",
        gap: 14,
        width: "100%",
        padding: "8px 0 0",
      }}
    >
      {items.map((item) => {
        const color = toneColorMap[item.tone] || "var(--tx-2)";
        return (
          <div
            key={item.label}
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              gap: 14,
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r)",
              padding: 15,
              boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
            }}
          >
            <Gauge value={item.value} max={total} size={52} stroke={4} color={color} />
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 23,
                  fontWeight: 700,
                  fontFamily: "var(--display)",
                  letterSpacing: "-0.03em",
                  color: "var(--tx)",
                  lineHeight: 1,
                }}
              >
                {item.value}
                <span style={{ fontSize: 13, color: "var(--tx-3)", fontWeight: 600 }}>
                  {" "}
                  / {total}
                </span>
              </div>
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--tx)",
                  fontWeight: 600,
                  marginTop: 4,
                }}
              >
                {item.label}
              </div>
              {item.meta && (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--tx-3)",
                    marginTop: 2,
                  }}
                >
                  {item.meta}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
