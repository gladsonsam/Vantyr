import { ConnectionFacts } from "@/features/devices/components/ConnectionFacts";
import { DeviceRules } from "@/features/devices/components/DeviceRules";
import { QueriesCard } from "@/features/devices/components/dns/QueriesCard";
import { QueryLog } from "@/features/devices/components/dns/QueryLog";
import { useDevice } from "@/features/devices/deviceContext";

/** This device as Vantyr DNS sees it: how much it asks, what is blocked, the log, and the rules behind it. */
export function DeviceDnsPage() {
  const device = useDevice();
  const dns = device.connections.dns;
  return (
    <div className="space-y-6">
      <ConnectionFacts title="Vantyr DNS" connection={dns} seenLabel="Last query" compact />
      {device.deviceId ? (
        <>
          <QueriesCard deviceId={device.deviceId} />
          <QueryLog deviceId={device.deviceId} />
          <DeviceRules deviceId={device.deviceId} />
        </>
      ) : null}
    </div>
  );
}
