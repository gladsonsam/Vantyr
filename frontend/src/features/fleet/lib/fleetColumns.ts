/** Columns the View menu can show or hide; Device, Status and the actions always stay. */
export type FleetColumnId = "activity" | "uptime" | "lastSeen" | "version";

export const FLEET_COLUMNS: { id: FleetColumnId; label: string; defaultVisible: boolean }[] = [
  { id: "activity", label: "Current activity", defaultVisible: true },
  { id: "uptime", label: "Uptime", defaultVisible: true },
  { id: "lastSeen", label: "Last seen", defaultVisible: false },
  { id: "version", label: "Version", defaultVisible: true },
];

export const DEFAULT_FLEET_COLUMNS: ReadonlySet<FleetColumnId> = new Set(
  FLEET_COLUMNS.filter((column) => column.defaultVisible).map((column) => column.id),
);

