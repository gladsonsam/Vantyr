import { ConnectionFacts } from "@/features/devices/components/ConnectionFacts";
import { QueryLog } from "@/features/devices/components/dns/QueryLog";
import { HttpsInspectionCard } from "@/features/devices/components/proxy/HttpsInspectionCard";
import { ProxyStatsCard } from "@/features/devices/components/proxy/ProxyStatsCard";
import { SignInCard } from "@/features/devices/components/proxy/SignInCard";
import { useDevice } from "@/features/devices/deviceContext";

/** This device as the Vantyr proxy sees it: how much it sends, what is blocked, how it signs in, and inspection. */
export function DeviceProxyPage() {
  const device = useDevice();
  const proxy = device.connections.proxy;
  return (
    <div className="space-y-6">
      <ConnectionFacts title="Vantyr proxy" connection={proxy} seenLabel="Last request" compact />
      {device.deviceId ? <ProxyStatsCard deviceId={device.deviceId} /> : null}
      <SignInCard label={device.label} />
      <HttpsInspectionCard label={device.label} />
      {device.deviceId ? <QueryLog deviceId={device.deviceId} source="proxy" /> : null}
    </div>
  );
}
