import { Card, CardContent } from "@vantyr/ui/components/card";
import { ConnectionStatus } from "@/features/devices/components/ConnectionStatus";
import { DeviceDecisions } from "@/features/devices/components/DeviceDecisions";
import { useDevice } from "@/features/devices/deviceContext";
import { IDENTITY_NOTE } from "@/features/devices/lib/identity";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { UnavailableSection } from "@/features/network/components/AvailabilityGate";
import { useProxyQuery } from "@/features/network/runtime/useRuntimeQueries";

function Credential({ label }: { label: string }) {
  const query = useProxyQuery();
  if (query.isPending) return null;
  if (query.isError)
    return <UnavailableSection title="Credential" reason="Couldn’t load the proxy." />;
  if (query.data.state === "unavailable") {
    return <UnavailableSection title="Credential" reason={query.data.reason} />;
  }
  const credentials = query.data.data.credentials;
  if (credentials.state === "unavailable") {
    return <UnavailableSection title="Credential" reason={credentials.reason} />;
  }
  const mine = credentials.data.filter((c) => c.label === label);
  return (
    <Card className="gap-0 py-0">
      <CardContent className="space-y-3 p-5">
        <h3 className="font-medium">Credential</h3>
        {mine.length === 0 ? (
          <p className="text-sm text-muted-foreground">No credential is issued to this device.</p>
        ) : (
          <ul className="divide-y divide-border">
            {mine.map((credential) => (
              <li
                key={credential.id}
                className="flex items-baseline justify-between gap-4 py-2.5 text-sm"
              >
                <span>{credential.revoked ? "Revoked" : "Active"}</span>
                <span className="text-muted-foreground">
                  {credential.lastUsedAt ? (
                    <>
                      Last used <TimeAgo iso={credential.lastUsedAt} />
                    </>
                  ) : (
                    "Never used"
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** This device as the Vantyr proxy sees it: the connection, its credential, and what it decided. */
export function DeviceProxyPage() {
  const device = useDevice();
  const proxy = device.connections.proxy;
  return (
    <div className="space-y-8">
      <Card className="gap-0 py-0">
        <CardContent className="flex flex-wrap items-center justify-between gap-6 p-5">
          <div className="space-y-1">
            <div className="flex items-center gap-4">
              <h3 className="font-medium">Vantyr proxy</h3>
              <ConnectionStatus state={proxy.state} />
            </div>
            <p className="text-sm text-muted-foreground">{IDENTITY_NOTE.proxy}</p>
          </div>
          <p className="text-sm text-muted-foreground">
            Last request <TimeAgo iso={proxy.lastSeenAt} />
          </p>
        </CardContent>
      </Card>
      <Credential label={device.label} />
      {device.deviceId ? (
        <DeviceDecisions
          deviceId={device.deviceId}
          source="proxy"
          limit={15}
          title="Recent proxy decisions"
        />
      ) : null}
    </div>
  );
}
