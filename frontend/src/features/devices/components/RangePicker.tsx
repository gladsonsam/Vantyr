import RubberSegment from "@/components/react-bits/RubberSegment";
import type { StatsRange } from "@/features/network/runtime/types";

const RANGES: StatsRange[] = ["24h", "7d", "30d"];

/** The 24h / 7d / 30d control shared by the DNS and Proxy statistics. */
export function RangePicker({
  value,
  onChange,
}: {
  value: StatsRange;
  onChange: (next: StatsRange) => void;
}) {
  return (
    <div className="flex justify-end">
      <RubberSegment
        aria-label="Time range"
        items={RANGES.map((r) => ({ value: r, label: r }))}
        value={value}
        onChange={(next) => onChange(next as StatsRange)}
        size="sm"
        trackColor="var(--muted)"
        thumbColor="var(--primary)"
        textColor="var(--muted-foreground)"
        activeTextColor="var(--primary-foreground)"
      />
    </div>
  );
}
