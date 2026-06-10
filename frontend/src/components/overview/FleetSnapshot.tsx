import clsx from "clsx";

interface FleetSnapshotItem {
  label: string;
  value: number;
  meta: string;
  tone: "connected" | "active" | "afk" | "offline" | "danger";
}

interface FleetSnapshotProps {
  items: FleetSnapshotItem[];
}

export function FleetSnapshot({ items }: FleetSnapshotProps) {
  return (
    <section className="vantyr-fleet-snapshot sx-console" aria-label="Fleet snapshot">
      {items.map((item) => (
        <div key={item.label} className={clsx("vantyr-fleet-snapshot__item", `is-${item.tone}`)}>
          <div className="vantyr-fleet-snapshot__glyph" aria-hidden="true">
            <span />
          </div>
          <div className="vantyr-fleet-snapshot__body">
            <div className="vantyr-fleet-snapshot__line">
              <span className="vantyr-fleet-snapshot__value sx-mono">{item.value}</span>
              <span className="vantyr-fleet-snapshot__label">{item.label}</span>
            </div>
            <div className="vantyr-fleet-snapshot__meta">{item.meta}</div>
          </div>
        </div>
      ))}
    </section>
  );
}
