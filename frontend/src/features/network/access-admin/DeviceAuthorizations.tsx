import { useState } from "react";
import { ShieldPlus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { errorText } from "@/api";
import {
  networkQueries,
  useAuthorizeDevice,
  useDeviceAuthorizations,
} from "@/api/queries/network";
import { Button } from "@vantyr/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { Spinner } from "@vantyr/ui/components/spinner";
import { HelpTip } from "@/components/common/HelpTip";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { StatusDot } from "@/features/network/enroll/StatusDot";

/** Pre-authorized household devices for one binding, with a paged list. */
export function DeviceAuthorizations({
  household,
  binding,
  active,
}: {
  household: string;
  binding: string;
  active: boolean;
}) {
  const list = useDeviceAuthorizations(household, binding);
  const devices = useQuery(networkQueries.devices(household));
  const authorize = useAuthorizeDevice(household, binding);
  const [device, setDevice] = useState<string | null>(null);

  const deviceRows = devices.data?.devices ?? [];
  const label = (id: string) => deviceRows.find((d) => d.id === id)?.label ?? id;
  const rows = list.data?.pages.flatMap((p) => p.enrollments) ?? [];

  return (
    <div className="space-y-3 border-t border-border/50 bg-card/5 px-5 py-4">
      <div className="flex items-center gap-1.5 text-sm font-semibold">
        Device authorizations
        <HelpTip label="About device authorizations">
          Pre-authorizing lets this person use an existing household device for setup without
          registering it themselves. A household can hold at most 100 live enrollments at once;
          ending an enrollment frees its place.
        </HelpTip>
      </div>

      {active ? (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={device} onValueChange={(v) => setDevice(v as string | null)}>
            <SelectTrigger className="w-64" aria-label="Device to authorize">
              <SelectValue placeholder="Choose a household device" />
            </SelectTrigger>
            <SelectContent>
              {deviceRows.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            disabled={!device || authorize.isPending}
            onClick={() => device && authorize.mutate(device, { onSuccess: () => setDevice(null) })}
          >
            {authorize.isPending ? <Spinner /> : <ShieldPlus />} Authorize device
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          This binding is revoked, so no new devices can be authorized.
        </p>
      )}
      {authorize.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(authorize.error)}
        </p>
      ) : null}

      {list.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : list.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(list.error)}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No devices authorized yet.</p>
      ) : (
        <ul className="divide-y divide-border/50 rounded-xl border border-border/70">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
              <span className="text-sm font-medium">{label(row.device_id)}</span>
              <span className="flex items-center gap-4 text-[0.8125rem] text-muted-foreground">
                <StatusDot
                  tone={row.status === "enrolled" ? "success" : "muted"}
                  label={row.status === "enrolled" ? "Enrolled" : row.status}
                />
                <TimeAgo iso={row.created_at} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? <Spinner /> : null} Load more
        </Button>
      ) : null}
    </div>
  );
}
