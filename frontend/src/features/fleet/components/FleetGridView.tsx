import { Activity, ArrowUpCircle, MonitorPlay } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Card } from "@vantyr/ui/components/card";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import { cn } from "@/lib/utils";
import { formatLastSeen, formatUptime, normalizeVersion } from "@/features/fleet/lib/fleetUtils";
import { AgentActionsMenu } from "./AgentActionsMenu";
import { ActivityCell } from "./ActivityCell";
import { FavoriteToggle } from "./FavoriteToggle";
import { PolicyBadges } from "./PolicyBadges";
import { DeviceIcon, OsMark, StatusDot, StatusText } from "./FleetStatus";
import { statusTone } from "@/features/fleet/lib/statusTone";
import type { FleetViewProps } from "./FleetTableView";

function Meta({ label, children, title, className }: { label: string; children: React.ReactNode; title?: string; className?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-1 truncate font-mono text-[13px] tabular-nums", className)}>{children}</dd>
    </div>
  );
}

export function FleetGridView({ rows, favoriteIds, onToggleFavorite, selection, latestAgentVersion, handlers }: FleetViewProps) {
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2 min-[87.5rem]:grid-cols-3 min-[120rem]:grid-cols-4">
      {rows.map((row, index) => {
        const checked = Boolean(selection?.selected.has(row.id));
        const tone = statusTone(row);
        return (
          <Card
            key={row.id}
            onClick={() => handlers.onOpen(row)}
            data-selected={checked || undefined}
            style={{ animationDelay: `${Math.min(index * 45, 360)}ms` }}
            className={cn(
              "cursor-pointer gap-0 bg-linear-to-b to-transparent to-40% py-0 transition-[box-shadow,background-color,transform] [animation-fill-mode:both] animate-in fade-in-0 slide-in-from-bottom-3 hover:-translate-y-0.5 hover:bg-[color-mix(in_oklch,var(--ui-card),var(--foreground)_3%)]",
              tone.wash,
              "data-selected:ring-2 data-selected:ring-primary/70",
            )}
          >
            <div className="flex items-start gap-3.5 p-5 pb-4">
              <DeviceIcon row={row} />
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex items-center gap-2">
                  <span className={cn("truncate text-[15px] font-medium", !row.online && "text-muted-foreground")}>{row.displayName}</span>
                  <OsMark row={row} />
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
                  {tone.pulse ? (
                    <span className="relative inline-flex size-2 shrink-0" aria-hidden="true">
                      <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", tone.dot)} />
                      <span className={cn("relative inline-flex size-2 rounded-full", tone.dot)} />
                    </span>
                  ) : (
                    <StatusDot row={row} />
                  )}
                  <StatusText row={row} />
                  <span className="text-muted-foreground/40">·</span>
                  <span className="truncate font-mono text-muted-foreground">{row.user}</span>
                </div>
              </div>
              <div className="-mt-1 -mr-2 flex items-center" onClick={(event) => event.stopPropagation()}>
                <FavoriteToggle
                  name={row.displayName}
                  favorite={favoriteIds.has(row.id)}
                  disabled={!onToggleFavorite}
                  onToggle={() => onToggleFavorite?.(row.id)}
                />
                {selection && (
                  <label className="flex size-7 cursor-pointer items-center justify-center">
                    <Checkbox
                      aria-label={`Select ${row.displayName}`}
                      checked={checked}
                      disabled={selection.disabled}
                      onCheckedChange={() => selection.toggle(row.id)}
                    />
                  </label>
                )}
              </div>
            </div>

            <div className="mx-5 rounded-lg bg-background/50 px-3 py-2.5 ring-1 ring-inset ring-foreground/[0.05]">
              <ActivityCell row={row} />
            </div>

            <dl className="grid grid-cols-3 gap-4 px-5 pt-4 pb-3">
              <Meta
                label={row.online ? (row.infoReportedAt ? "Stored uptime" : "Uptime") : "Last seen"}
                title={row.online && row.infoReportedAt ? `Stored snapshot received ${row.infoReportedAt}; freshness is unknown` : undefined}
              >
                {row.online ? formatUptime(row.effectiveUptimeSecs) : formatLastSeen(row.last_seen)}
              </Meta>
              <Meta label="IP address">{row.ip}</Meta>
              <Meta
                label="Agent"
                className={cn(row.updateNeeded && "text-warning")}
                title={row.updateNeeded ? `Update to v${normalizeVersion(latestAgentVersion)} available` : undefined}
              >
                <span className="inline-flex items-center gap-1">
                  {row.version ? `v${normalizeVersion(row.version)}` : "-"}
                  {row.updateNeeded && <ArrowUpCircle className="size-3.5" aria-label="Update available" />}
                </span>
              </Meta>
            </dl>

            <div className="px-5 pb-4 empty:hidden">
              <PolicyBadges row={row} />
            </div>

            <div className="mt-auto flex items-center gap-2 px-4 pt-1 pb-4" onClick={(event) => event.stopPropagation()}>
              <Button className="flex-1" disabled={!row.online} onClick={() => handlers.onLive(row)}>
                <MonitorPlay /> Live
              </Button>
              <Button variant="outline" className="flex-1" disabled={!row.online} onClick={() => handlers.onActivity(row)}>
                <Activity /> Activity
              </Button>
              <AgentActionsMenu row={row} handlers={handlers} />
            </div>
          </Card>
        );
      })}
    </div>
  );
}
