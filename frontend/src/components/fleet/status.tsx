import { cn } from "@/lib/utils";
import { AGENT_ICON_MAP, isAgentIconKey } from "@/lib/agentIcons";
import { OsBadge } from "@/components/common/OsBadge";
import type { FleetRow } from "@/components/overview/types";

type Tone = {
  label: string;
  /** Plain text colour for the status word. */
  text: string;
  /** Faint wash across the top of a device card. */
  wash: string;
  dot: string;
};

/**
 * Visual tone for a fleet row's connectivity/activity state. Status is carried
 * by hue on existing elements (card wash, text) rather than chips.
 */
export function statusTone(row: Pick<FleetRow, "online" | "status">): Tone {
  if (!row.online) {
    return { label: "Offline", text: "text-muted-foreground", wash: "", dot: "bg-muted-foreground/50" };
  }
  if (row.status === "afk") {
    return { label: "Away", text: "text-warning", wash: "from-warning/[0.07]", dot: "bg-warning" };
  }
  const active = row.status === "active";
  return {
    label: active ? "Active" : "Online",
    text: "text-success",
    wash: active ? "from-success/[0.09]" : "from-success/[0.05]",
    dot: "bg-success",
  };
}

export function StatusDot({ row, className }: { row: Pick<FleetRow, "online" | "status">; className?: string }) {
  const tone = statusTone(row);
  return <span className={cn("inline-flex size-2 shrink-0 rounded-full", tone.dot, className)} aria-hidden="true" />;
}

/** The status word in its hue — no chip, just coloured text. */
export function StatusText({ row, className }: { row: Pick<FleetRow, "online" | "status">; className?: string }) {
  const tone = statusTone(row);
  return <span className={cn("text-xs font-medium", tone.text, className)}>{tone.label}</span>;
}

/** Device glyph: the user-chosen agent icon in a neutral tile. */
export function DeviceIcon({ row, className }: { row: FleetRow; className?: string }) {
  const key = row.icon && isAgentIconKey(row.icon) ? row.icon : "monitor";
  const Icon = AGENT_ICON_MAP[key].Icon;
  return (
    <div
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/70",
        row.online ? "text-foreground/80" : "text-muted-foreground/70",
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
