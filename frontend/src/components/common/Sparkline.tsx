const W = 200;
const H = 48;

/** Smooth path through the points: cubic segments with horizontal control handles at the midpoints. */
function smoothPath(points: [number, number][]): string {
  if (points.length === 0) return "";
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const mx = (x0 + x1) / 2;
    d += ` C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
  }
  return d;
}

/**
 * A tiny trend line with a flat translucent fill underneath. Takes its colour from the text colour
 * of the element it sits in (`currentColor`), so the caller sets the hue with a text-* class.
 */
export function Sparkline({
  values,
  className,
  max,
}: {
  values: number[];
  className?: string;
  /** Fixed top of the scale, e.g. 100 for a percentage; defaults to the largest value. */
  max?: number;
}) {
  const top = Math.max(max ?? 0, ...values, 1e-9);
  const pad = 2;
  const step = values.length > 1 ? W / (values.length - 1) : W;
  const points: [number, number][] = (values.length === 1 ? [values[0], values[0]] : values).map(
    (value, index) => [index * step, H - pad - (value / top) * (H - pad * 2)],
  );
  const line = smoothPath(points);
  const lastX = points.length ? points[points.length - 1][0] : W;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {line ? (
        <>
          <path d={`${line} L${lastX},${H} L0,${H} Z`} fill="currentColor" fillOpacity={0.12} />
          <path
            d={line}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </>
      ) : null}
    </svg>
  );
}
