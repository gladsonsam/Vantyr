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
    <section className="sentinel-fleet-snapshot sx-console" aria-label="Fleet snapshot">
      {items.map((item) => (
        <div key={item.label} className={clsx("sentinel-fleet-snapshot__item", `is-${item.tone}`)}>
          <div className="sentinel-fleet-snapshot__glyph" aria-hidden="true">
            <span />
          </div>
          <div className="sentinel-fleet-snapshot__body">
            <div className="sentinel-fleet-snapshot__line">
              <span className="sentinel-fleet-snapshot__value sx-mono">{item.value}</span>
              <span className="sentinel-fleet-snapshot__label">{item.label}</span>
            </div>
            <div className="sentinel-fleet-snapshot__meta">{item.meta}</div>
          </div>
        </div>
      ))}
    </section>
  );
}
