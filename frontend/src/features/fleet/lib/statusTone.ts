import type { FleetRow } from "@/features/fleet/types";

type Tone = {
  label: string;
  /** Plain text colour for the status word. */
  text: string;
  /** Faint wash across the top of a device card. */
  wash: string;
  dot: string;
  /** Whether the status dot should breathe (active devices only). */
  pulse: boolean;
};

/**
 * Visual tone for a fleet row's connectivity/activity state. Colour is
 * reserved for the status word and dot only — cards stay neutral.
 */
export function statusTone(row: Pick<FleetRow, "online" | "status">): Tone {
  if (!row.online) {
    return {
      label: "Offline",
      text: "text-muted-foreground",
      wash: "",
      dot: "bg-muted-foreground/50",
      pulse: false,
    };
  }
  if (row.status === "afk") {
    return {
      label: "Away",
      text: "text-warning",
      wash: "from-warning/[0.07]",
      dot: "bg-warning",
      pulse: false,
    };
  }
  const active = row.status === "active";
  return {
    label: active ? "Active" : "Online",
    text: "text-success",
    wash: active ? "from-success/[0.09]" : "from-success/[0.05]",
    dot: "bg-success",
    pulse: active,
  };
}
