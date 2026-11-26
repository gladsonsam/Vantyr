import type { ReactNode } from "react";
import { useDevice } from "@/features/devices/deviceContext";
import { ConnectionCard } from "@/features/devices/components/ConnectionCard";
import { DeviceDecisions } from "@/features/devices/components/DeviceDecisions";
import { DeviceRules } from "@/features/devices/components/DeviceRules";
import { OverviewCard } from "@/features/devices/components/OverviewCard";
import { OverviewDnsStats } from "@/features/devices/components/OverviewStats";
import {
  CONNECTION_KINDS,
  connectedCount,
} from "@/features/devices/lib/deviceModel";
import { TimeAgo } from "@/features/network/components/TimeAgo";

function Figure({ label, value, hue }: { label: string; value: ReactNode; hue: string }) {
  return (
    <div className="min-w-0 space-y-3">
      <div className="rounded-xl border border-border/70 bg-card/10 px-5 py-5 text-3xl font-semibold tabular-nums tracking-tight">
        {value}
      </div>
      <div className={`px-1 text-base font-medium ${hue}`}>{label}</div>
    </div>
  );
}

/** Built from whatever the device is connected through: the figures, the connections, then what happened and what applies. */
export function DeviceOverviewPage() {
  const device = useDevice();
  const base = `/devices/${device.key}`;
  // Only the connections this device has; a device that connects another way is not missing anything.
  const present = CONNECTION_KINDS.filter((kind) => device.connections[kind].state !== "none");
  const lastSeen = present
    .map((kind) => device.connections[kind].lastSeenAt)
    .filter((at): at is string => Boolean(at))
    .sort()
    .pop();
  const hasDns = device.connections.dns.state !== "none";
  return (
    <div className="space-y-6">
      {hasDns && device.deviceId ? (
        <OverviewDnsStats deviceId={device.deviceId} />
      ) : (
        <div className="grid grid-cols-2 gap-5 lg:grid-cols-3">
          <Figure
            label="Reporting"
            value={`${connectedCount(device)} of ${present.length}`}
            hue="text-primary"
          />
          <Figure label="People" value={device.people.length} hue="text-info" />
          <Figure
            label="Last seen"
            value={lastSeen ? <TimeAgo iso={lastSeen} /> : "—"}
            hue="text-warning"
          />
        </div>
      )}
      <OverviewCard title="Connections">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {present.map((kind) => (
            <ConnectionCard
              key={kind}
              connection={device.connections[kind]}
              to={`${base}/${kind}`}
              deviceId={device.deviceId}
              deviceLabel={device.label}
            />
          ))}
        </div>
      </OverviewCard>
      {device.deviceId ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <DeviceDecisions
            deviceId={device.deviceId}
            limit={5}
            compact
            className="h-full"
            viewAllTo={hasDns ? `${base}/dns` : undefined}
          />
          <DeviceRules
            deviceId={device.deviceId}
            summary
            className="h-full"
            personIds={device.people.map((p) => p.person.id)}
          />
        </div>
      ) : null}
    </div>
  );
}
