import type { ReactNode } from "react";
import { Avatar, AvatarFallback } from "@vantyr/ui/components/avatar";
import { HelpTip } from "@/components/common/HelpTip";
import { useDevice } from "@/features/devices/deviceContext";
import { ConnectionCard } from "@/features/devices/components/ConnectionCard";
import { DeviceDecisions } from "@/features/devices/components/DeviceDecisions";
import { DeviceRules } from "@/features/devices/components/DeviceRules";
import { OverviewDnsStats } from "@/features/devices/components/OverviewStats";
import {
  CONNECTION_KINDS,
  connectedCount,
  type DeviceRow,
} from "@/features/devices/lib/deviceModel";
import { TimeAgo } from "@/features/network/components/TimeAgo";

function Figure({ label, value, hue }: { label: string; value: ReactNode; hue: string }) {
  return (
    <div className="min-w-0 space-y-2">
      <div className="rounded-xl border border-border/70 bg-card/10 px-4 py-4 text-2xl font-semibold tabular-nums tracking-tight">
        {value}
      </div>
      <div className={`px-1 text-sm font-medium ${hue}`}>{label}</div>
    </div>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}

function WhoUsesIt({ device }: { device: DeviceRow }) {
  // Only an agent can say who is signed in; every other connection leaves it unknown.
  const agentConnected = device.connections.agent.state === "connected";
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-1.5 text-sm font-medium">
        Who uses it
        <HelpTip label="About who uses it">
          {agentConnected
            ? "The agent can verify who is signed in, so that person’s rules apply while they are."
            : "Nobody can be verified on this device right now, so its device defaults apply to everyone. An owner is who it belongs to, not necessarily who is using it."}
        </HelpTip>
      </h3>
      {device.people.length === 0 ? (
        <p className="text-sm text-muted-foreground">No one is assigned to this device.</p>
      ) : (
        <ul className="flex flex-wrap gap-x-6 gap-y-3">
          {device.people.map(({ assignmentId, person, role }) => (
            <li key={assignmentId} className="flex items-center gap-2.5 text-sm">
              <Avatar size="sm">
                <AvatarFallback>{initials(person.display_name)}</AvatarFallback>
              </Avatar>
              <span className="font-medium">{person.display_name}</span>
              <span className="text-muted-foreground">{role}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
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
    <div className="space-y-10">
      {hasDns && device.deviceId ? (
        <OverviewDnsStats deviceId={device.deviceId} />
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
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
      <section className="space-y-3">
        <h3 className="text-sm font-medium">Connections</h3>
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
      </section>
      {device.deviceId ? (
        <div className="grid gap-10 lg:grid-cols-2">
          <DeviceDecisions
            deviceId={device.deviceId}
            limit={5}
            compact
            viewAllTo={hasDns ? `${base}/dns` : undefined}
          />
          <DeviceRules
            deviceId={device.deviceId}
            summary
            personIds={device.people.map((p) => p.person.id)}
          />
        </div>
      ) : null}
      <WhoUsesIt device={device} />
    </div>
  );
}
