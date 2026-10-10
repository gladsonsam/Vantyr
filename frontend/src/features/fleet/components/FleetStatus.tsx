import { cn } from "@/lib/utils";
import { AGENT_ICON_MAP, isAgentIconKey } from "@/features/fleet/lib/agentIcons";
import { OsBadge } from "@/components/common/OsBadge";
import type { FleetRow } from "@/features/fleet/types";
import { statusTone } from "@/features/fleet/lib/statusTone";

export function StatusDot({ row, className }: { row: Pick<FleetRow, "online" | "status">; className?: string }) {
  const tone = statusTone(row);
  return <span className={cn("inline-flex size-2 shrink-0 rounded-full", tone.dot, className)} aria-hidden="true" />;
}

/** The status word in its hue — no chip, just coloured text. */
export function StatusText({ row, className }: { row: Pick<FleetRow, "online" | "status">; className?: string }) {
  const tone = statusTone(row);
  return <span className={cn("text-xs font-medium", tone.text, className)}>{tone.label}</span>;
}

/**
 * Device glyph: the user-chosen agent icon in a tile. With `showStatus` the tile
 * carries the status hue (green active/online, amber away, grey offline) instead
 * of a separate dot or label.
 */
export function DeviceIcon({ row, className, showStatus }: { row: FleetRow; className?: string; showStatus?: boolean }) {
  const key = row.icon && isAgentIconKey(row.icon) ? row.icon : "monitor";
  const Icon = AGENT_ICON_MAP[key].Icon;
  const tone = statusTone(row);
  return (
    <div
      title={showStatus ? tone.label : undefined}
      aria-label={showStatus ? tone.label : undefined}
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-xl",
        showStatus
          ? cn("bg-current/10", tone.text, !row.online && "opacity-70")
          : cn("bg-muted/70", row.online ? "text-foreground/80" : "text-muted-foreground/70"),
        className,
      )}
    >
      <Icon size={19} />
    </div>
  );
}

/** Small OS mark shown next to a device name. */
export function OsMark({ row }: { row: FleetRow }) {
  return <OsBadge os={row.os} size={18} style={{ flexShrink: 0, border: 0, background: "transparent" }} />;
}
