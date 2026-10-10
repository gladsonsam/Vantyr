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
import { DeviceIcon, OsMark } from "./FleetStatus";
import type { FleetViewProps } from "./FleetTableView";

function Meta({ label, children, title, className }: { label: string; children: React.ReactNode; title?: string; className?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn("mt-1 truncate font-mono text-[13px] tabular-nums", className)}>{children}</dd>
    </div>
  );
}

export function FleetGridView({ rows, favoriteIds, onToggleFavorite, selection, latestAgentVersion, handlers }: FleetViewProps) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 min-[87.5rem]:grid-cols-3 min-[120rem]:grid-cols-4">
      {rows.map((row) => {
        const checked = Boolean(selection?.selected.has(row.id));
        return (
          <Card
            key={row.id}
            onClick={() => handlers.onOpen(row)}
            data-selected={checked || undefined}
            className="cursor-pointer gap-0 rounded-lg border border-border/70 bg-[color-mix(in_oklch,var(--ui-card),white_5%)] py-0 shadow-none ring-0 transition-colors hover:border-foreground/20 data-selected:border-primary/70"
          >
            <div className="flex items-center gap-3 px-5 pt-5 pb-4">
              <DeviceIcon row={row} showStatus />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={cn("truncate text-[15px] font-semibold", !row.online && "text-muted-foreground")}>{row.displayName}</span>
                  <OsMark row={row} />
                </div>
                <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{row.user}</div>
              </div>
              <div className="-mr-2 flex items-center" onClick={(event) => event.stopPropagation()}>
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

            <div className="border-t border-border/60 bg-black/10 px-5 py-3.5">
              <ActivityCell row={row} />
            </div>

            <dl className="grid grid-cols-[6.5rem_9rem_auto] gap-x-4 gap-y-3 bg-black/10 px-5 pt-1 pb-3.5">
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

            <div className="bg-black/10 px-5 pb-3.5 empty:hidden">
              <PolicyBadges row={row} />
            </div>

            <div className="mt-auto flex items-center gap-1 border-t border-border/60 bg-black/20 px-3 py-2" onClick={(event) => event.stopPropagation()}>
              <Button variant="ghost" className="flex-1 font-medium text-foreground" disabled={!row.online} onClick={() => handlers.onLive(row)}>
                <MonitorPlay /> Live
              </Button>
              <Button variant="ghost" className="flex-1 text-muted-foreground hover:text-foreground" disabled={!row.online} onClick={() => handlers.onActivity(row)}>
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
