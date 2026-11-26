import type { StatsWindow } from "@/features/network/runtime/types";
import { shortenedWindowText } from "./statsWindowText";

/** Calm note shown only when the data covers less than the requested range. */
export function StatsWindowNote({ window }: { window: StatsWindow | undefined }) {
  if (!window?.shortened) return null;
  return (
    <p className="text-xs text-muted-foreground" role="status">
      {shortenedWindowText(window)}
    </p>
  );
}
