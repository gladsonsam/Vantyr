import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Card } from "@vantyr/ui/components/card";
import { cn } from "@/lib/utils";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { DEVICE_TYPE_ICON, DEVICE_TYPE_LABEL } from "@/features/devices/lib/deviceIcons";
import {
  CONNECTION_KINDS,
  connectedCount,
  type DeviceRow,
} from "@/features/devices/lib/deviceModel";
import { CONNECTION_LABEL } from "@/features/devices/lib/identity";

function peopleLine(row: DeviceRow): string {
  if (row.people.length === 0) return DEVICE_TYPE_LABEL[row.type];
  return row.people.map((p) => p.person.display_name).join(", ");
}

/**
 * A device as a card in the Devices grid, drawn like the agent cards beside it. It shows only the
 * connections the device has: a device that reaches Vantyr some other way is a device, not a lesser one.
 */
export function DeviceCard({ row }: { row: DeviceRow }) {
  const Icon = DEVICE_TYPE_ICON[row.type];
  const online = connectedCount(row) > 0;
  const present = CONNECTION_KINDS.filter((kind) => row.connections[kind].state !== "none");
  return (
    <Card className="gap-0 rounded-lg border border-border/70 bg-[color-mix(in_oklch,var(--ui-card),white_5%)] py-0 shadow-none ring-0 transition-colors hover:border-foreground/20">
      <Link
        to={`/devices/${row.key}`}
        className="flex flex-1 flex-col outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <div className="flex items-center gap-3 px-4 pt-3.5 pb-3 sm:px-5 sm:pt-4">
          <div
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-xl",
              online
                ? "bg-current/10 text-success"
                : "bg-current/10 text-muted-foreground opacity-70",
            )}
            aria-hidden="true"
          >
            <Icon size={19} />
          </div>
          <div className="min-w-0 flex-1">
            <div
              className={cn(
                "truncate text-[15px] font-semibold",
                !online && "text-muted-foreground",
              )}
            >
              {row.label}
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">{peopleLine(row)}</div>
          </div>
        </div>
        <div className="space-y-1.5 border-t border-border/60 bg-black/10 px-4 py-3 text-sm sm:px-5">
          {present.length === 0 ? (
            <span className="text-muted-foreground">No connections yet</span>
          ) : (
            present.map((kind) => {
              const connection = row.connections[kind];
              const live = connection.state === "connected";
              return (
                <div key={kind} className="flex items-center justify-between gap-3">
                  <span className="text-foreground/90">{CONNECTION_LABEL[kind]}</span>
                  <span
                    className={cn(
                      "flex items-center gap-1.5 text-xs",
                      live ? "text-success" : "text-warning",
                    )}
                  >
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-current"
                      aria-hidden="true"
                    />
                    {live ? (
                      "Connected"
                    ) : (
                      <>
                        Seen <TimeAgo iso={connection.lastSeenAt} />
                      </>
                    )}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </Link>
      <div className="mt-auto flex items-center gap-1 border-t border-border/60 bg-black/20 px-2 py-1.5 sm:px-3 sm:py-2">
        <Button
          variant="ghost"
          className="flex-1 font-medium text-foreground"
          nativeButton={false}
          render={<Link to={`/devices/${row.key}`} />}
          aria-label={`View ${row.label}`}
        >
          View <ArrowRight />
        </Button>
      </div>
    </Card>
  );
}
