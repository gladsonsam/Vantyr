import { Card, CardContent } from "@vantyr/ui/components/card";
import { useDevice } from "@/features/devices/deviceContext";
import { ConnectionCard } from "@/features/devices/components/ConnectionCard";
import { DeviceDecisions } from "@/features/devices/components/DeviceDecisions";
import { DeviceRules } from "@/features/devices/components/DeviceRules";
import { CONNECTION_KINDS, type DeviceRow } from "@/features/devices/lib/deviceModel";

function WhoUsesIt({ device }: { device: DeviceRow }) {
  // Only an agent can say who is signed in; every other connection leaves it unknown.
  const agentConnected = device.connections.agent.state === "connected";
  return (
    <Card className="gap-0 py-0">
      <CardContent className="space-y-4 p-5">
        <h3 className="font-medium">Who uses it</h3>
        {device.people.length === 0 ? (
          <p className="text-sm text-muted-foreground">No one is assigned to this device.</p>
        ) : (
          <ul className="divide-y divide-border">
            {device.people.map(({ assignmentId, person, role }) => (
              <li
                key={assignmentId}
                className="flex items-baseline justify-between gap-4 py-2.5 text-sm"
              >
                <span>{person.display_name}</span>
                <span className="text-muted-foreground">{role}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-muted-foreground">
          {agentConnected
            ? "The agent can verify who is signed in, so that person’s rules apply while they are."
            : "Nobody can be verified on this device right now, so its device defaults apply to everyone. An owner is who it belongs to, not necessarily who is using it."}
        </p>
      </CardContent>
    </Card>
  );
}

/** Built from whatever the device is connected through: a card per connection, then who and what applies. */
export function DeviceOverviewPage() {
  const device = useDevice();
  const base = `/devices/${device.key}`;
  // Only the connections this device has; a device that connects another way is not missing anything.
  const present = CONNECTION_KINDS.filter((kind) => device.connections[kind].state !== "none");
  return (
    <div className="space-y-8">
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {present.map((kind) => (
          <ConnectionCard key={kind} connection={device.connections[kind]} to={`${base}/${kind}`} />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <WhoUsesIt device={device} />
        {device.deviceId ? <DeviceRules deviceId={device.deviceId} /> : null}
      </div>
      {device.deviceId ? <DeviceDecisions deviceId={device.deviceId} /> : null}
    </div>
  );
}
