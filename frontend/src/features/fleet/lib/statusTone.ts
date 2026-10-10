import type { FleetRow } from "@/features/fleet/types";

type Tone = {
  label: string;
  /** Plain text colour for the status word. */
  text: string;
  dot: string;
};

/**
 * Visual tone for a fleet row's connectivity/activity state. Colour is
 * reserved for the status word and dot only — cards stay neutral, static.
 */
export function statusTone(row: Pick<FleetRow, "online" | "status">): Tone {
  if (!row.online) {
    return {
      label: "Offline",
      text: "text-muted-foreground",
      dot: "bg-muted-foreground/50",
    };
  }
  if (row.status === "afk") {
    return {
      label: "Away",
      text: "text-warning",
      dot: "bg-warning",
    };
  }
  const active = row.status === "active";
  return {
    label: active ? "Active" : "Online",
    text: "text-success",
    dot: "bg-success",
  };
}
