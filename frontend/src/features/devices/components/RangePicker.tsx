import RubberSegment from "@/components/react-bits/RubberSegment";
import type { StatsRange, StatsWindow } from "@/features/network/runtime/types";
import { StatsWindowNote } from "./dns/StatsWindowNote";

const RANGES: StatsRange[] = ["24h", "7d", "30d"];

/**
 * The 24h / 7d / 30d control shared by the DNS and Proxy statistics. When the data covers less than
 * the requested range, the note beside it says how much there really is.
 */
export function RangePicker({
  value,
  onChange,
  window,
}: {
  value: StatsRange;
  onChange: (next: StatsRange) => void;
  window?: StatsWindow;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
      <StatsWindowNote window={window} />
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
