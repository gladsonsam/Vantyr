import clsx from "clsx";
import { ChevronDown } from "lucide-react";

export type SortKey = "status" | "agent" | "activity" | "version" | "uptime" | "lastWindow";

interface SortableThProps {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  desc: boolean;
  onSort: (key: SortKey) => void;
}

export function SortableTh({
  label,
  sortKey,
  activeKey,
  desc,
  onSort,
}: SortableThProps) {
  const active = sortKey === activeKey;
  return (
    <th>
      <button type="button" className={clsx("vantyr-fleet-th", active && "is-active")} onClick={() => onSort(sortKey)}>
        <span>{label}</span>
        {active ? <ChevronDown size={13} className={clsx(!desc && "is-asc")} aria-hidden="true" /> : null}
      </button>
    </th>
  );
}
