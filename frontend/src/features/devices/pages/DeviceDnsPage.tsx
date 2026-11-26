import { Card, CardContent } from "@vantyr/ui/components/card";
import { ConnectionStatus } from "@/features/devices/components/ConnectionStatus";
import { DeviceRules } from "@/features/devices/components/DeviceRules";
import { QueriesCard } from "@/features/devices/components/dns/QueriesCard";
import { QueryLog } from "@/features/devices/components/dns/QueryLog";
import { useDevice } from "@/features/devices/deviceContext";
import { IDENTITY_NOTE } from "@/features/devices/lib/identity";
import { TimeAgo } from "@/features/network/components/TimeAgo";

/** This device as Vantyr DNS sees it: how much it asks, what is blocked, the log, and the rules behind it. */
export function DeviceDnsPage() {
  const device = useDevice();
  const dns = device.connections.dns;
  return (
    <div className="space-y-8">
      <Card className="gap-0 py-0">
        <CardContent className="flex flex-wrap items-center justify-between gap-6 p-5">
          <div className="space-y-1">
            <div className="flex items-center gap-4">
              <h3 className="font-medium">Vantyr DNS</h3>
              <ConnectionStatus state={dns.state} />
            </div>
            <p className="text-sm text-muted-foreground">{IDENTITY_NOTE.dns}</p>
          </div>
          <p className="text-sm text-muted-foreground">
            Last query <TimeAgo iso={dns.lastSeenAt} />
          </p>
        </CardContent>
      </Card>
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
