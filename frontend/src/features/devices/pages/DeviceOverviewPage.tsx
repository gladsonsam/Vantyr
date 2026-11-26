import { Cable, Clock, Users } from "lucide-react";
import { DetailMetaStrip } from "@/components/common/resource-detail/DetailMetaStrip";
import { DetailSection } from "@/components/common/resource-detail/DetailSection";
import { KeyValueCard, KeyValueGrid } from "@/components/common/resource-detail/KeyValueCard";
import { useDevice } from "@/features/devices/deviceContext";
import { ConnectionCard } from "@/features/devices/components/ConnectionCard";
import { DeviceDecisions } from "@/features/devices/components/DeviceDecisions";
import { DeviceRules } from "@/features/devices/components/DeviceRules";
import {
  CONNECTION_KINDS,
  connectedCount,
  type DeviceRow,
} from "@/features/devices/lib/deviceModel";
import { TimeAgo } from "@/features/network/components/TimeAgo";

function WhoUsesIt({ device }: { device: DeviceRow }) {
  // Only an agent can say who is signed in; every other connection leaves it unknown.
  const agentConnected = device.connections.agent.state === "connected";
  return (
    <DetailSection title="Who uses it" icon={Users}>
      {device.people.length === 0 ? (
        <p className="text-sm text-muted-foreground">No one is assigned to this device.</p>
      ) : (
        <KeyValueGrid>
          {device.people.map(({ assignmentId, person, role }) => (
            <KeyValueCard key={assignmentId} label={role} format="text">
              {person.display_name}
            </KeyValueCard>
          ))}
        </KeyValueGrid>
      )}
      <p className="text-sm text-muted-foreground">
        {agentConnected
          ? "The agent can verify who is signed in, so that person’s rules apply while they are."
          : "Nobody can be verified on this device right now, so its device defaults apply to everyone. An owner is who it belongs to, not necessarily who is using it."}
      </p>
    </DetailSection>
  );
}

/** Built from whatever the device is connected through: a card per connection, then who and what applies. */
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
  return (
    <div className="space-y-8">
      <DetailMetaStrip
        items={[
          {
            icon: Cable,
            label: "Reporting",
            value: `${connectedCount(device)} of ${present.length}`,
          },
          {
            icon: Users,
            label: "People",
            value: device.people.length,
          },
          ...(lastSeen
            ? [{ icon: Clock, label: "Last seen", value: <TimeAgo iso={lastSeen} /> }]
            : []),
        ]}
      />
      <DetailSection title="Connections" icon={Cable}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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
      </DetailSection>
      <WhoUsesIt device={device} />
      {device.deviceId ? <DeviceRules deviceId={device.deviceId} /> : null}
      {device.deviceId ? <DeviceDecisions deviceId={device.deviceId} /> : null}
    </div>
  );
}
