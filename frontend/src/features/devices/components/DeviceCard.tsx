import { Link, useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import {
  ResourceCard,
  ResourceCardField,
  ResourceCardFields,
} from "@/components/common/data-table/ResourceCard";
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
 * A device as a resource card in the Devices grid, drawn like the agent cards beside it. It shows only the
 * connections the device has: a device that reaches Vantyr some other way is a device, not a lesser one.
 */
export function DeviceCard({ row }: { row: DeviceRow }) {
  const navigate = useNavigate();
  const Icon = DEVICE_TYPE_ICON[row.type];
  const online = connectedCount(row) > 0;
  const present = CONNECTION_KINDS.filter((kind) => row.connections[kind].state !== "none");
  return (
    <ResourceCard
      onClick={() => navigate(`/devices/${row.key}`)}
      icon={
        <div
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-xl bg-current/10",
            online ? "text-success" : "text-muted-foreground opacity-70",
          )}
          aria-hidden="true"
        >
          <Icon size={19} />
        </div>
      }
      title={
        <>
          <div
            className={cn("truncate text-[15px] font-semibold", !online && "text-muted-foreground")}
          >
            {row.label}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{peopleLine(row)}</div>
        </>
      }
      fields={
        present.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">No connections yet</p>
        ) : (
          <ResourceCardFields>
            {present.map((kind) => {
              const connection = row.connections[kind];
              const live = connection.state === "connected";
              return (
                <ResourceCardField key={kind} label={CONNECTION_LABEL[kind]}>
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
                </ResourceCardField>
              );
            })}
          </ResourceCardFields>
        )
      }
      footer={
        <div className="-mx-2 flex w-full items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 font-medium text-foreground"
            nativeButton={false}
            render={<Link to={`/devices/${row.key}`} />}
            aria-label={`View ${row.label}`}
          >
            View <ArrowRight />
          </Button>
        </div>
      }
    />
  );
}
