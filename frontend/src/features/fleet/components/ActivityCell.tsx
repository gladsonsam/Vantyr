import { AppWindow } from "lucide-react";
import { AppIcon } from "@/components/common/AppIcon";
import { prettyAppLabel } from "@/lib/appNames";
import { cn } from "@/lib/utils";
import { hasValue, storedWindowTooltip } from "@/features/fleet/lib/fleetUtils";
import type { FleetRow } from "@/features/fleet/types";

/** Splits "Title - App" window captions into an app line and a title line. */
function windowParts(row: FleetRow) {
  let app = prettyAppLabel({ exeName: row.liveStatus?.app });
  let title = row.lastWindow || "-";
  if (row.lastWindow && row.lastWindow.includes(" - ")) {
    const parts = row.lastWindow.split(" - ");
    const appPart = parts[parts.length - 1].trim();
    const titlePart = parts.slice(0, -1).join(" - ").trim();
    if (appPart && titlePart) {
      app = appPart;
      title = titlePart;
    }
  }
  return { app, title };
}

export function ActivityCell({ row, className }: { row: FleetRow; className?: string }) {
  const { app, title } = windowParts(row);
  const empty = !hasValue(row.lastWindow) && !hasValue(row.liveStatus?.app);
  return (
    <div
      title={storedWindowTooltip(row.windowReportedAt)}
      className={cn("flex min-w-0 items-center gap-2.5", className)}
    >
      <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/50">
        <AppIcon
          agentId={row.id}
          exeName={row.liveStatus?.app}
          size={16}
          fallback={<AppWindow className="size-3.5 text-muted-foreground" />}
        />
      </div>
      <div className="min-w-0">
        {empty ? (
          <>
            <div className="truncate text-[13px] text-muted-foreground">No recent activity</div>
            <div className="truncate text-xs text-muted-foreground/70">{row.online ? "Nothing reported yet" : "Device is offline"}</div>
          </>
        ) : (
          <>
            <div className={cn("truncate text-[13px] font-medium", !row.online && "text-muted-foreground")}>{app}</div>
            <div className="truncate text-xs text-muted-foreground">{hasValue(title) ? title : "No window title"}</div>
          </>
        )}
      </div>
    </div>
  );
}
