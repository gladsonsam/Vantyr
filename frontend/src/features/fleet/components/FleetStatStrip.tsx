import { ArrowUpCircle, Monitor, Wifi, WifiOff } from "lucide-react";
import { StatStrip, StatStripDivider, StatStripItem } from "@/components/common/StatStrip";
import type { FleetStatusFilter } from "@/features/fleet/lib/fleetPreferences";
import type { StatusCounts } from "./FleetToolbar";

interface Props {
  counts: StatusCounts;
  /** Devices whose agent is behind the latest release. */
  updates: number;
  /** Current status filter; with `onStatus` the stats toggle it, as Arcane's header stats do. */
  status?: FleetStatusFilter;
  onStatus?: (status: FleetStatusFilter) => void;
}

/** Arcane's header stat row: icon, number and label per stat, split by hairlines. */
export function FleetStatStrip({ counts, updates, status, onStatus }: Props) {
  const toggle = (value: FleetStatusFilter) =>
    onStatus ? () => onStatus(status === value ? "all" : value) : undefined;
  return (
    <div role="group" aria-label="Fleet summary">
      <StatStrip className="gap-x-2">
        <StatStripItem
          icon={Monitor}
          tone="text-info"
          value={counts.all}
          label="Devices"
          onClick={toggle("all")}
          active={status === "all"}
        />
        <StatStripDivider />
        <StatStripItem
          icon={Wifi}
          tone="text-success"
          value={counts.online}
          label="Online"
          onClick={toggle("online")}
          active={status === "online"}
        />
        <StatStripDivider />
        <StatStripItem
          icon={WifiOff}
          tone="text-muted-foreground"
          value={counts.offline}
          label="Offline"
          onClick={toggle("offline")}
          active={status === "offline"}
        />
        {updates > 0 && (
          <>
            <StatStripDivider />
            <StatStripItem
              icon={ArrowUpCircle}
              tone="text-warning"
              value={updates}
              label="Need update"
            />
          </>
        )}
      </StatStrip>
    </div>
  );
}
