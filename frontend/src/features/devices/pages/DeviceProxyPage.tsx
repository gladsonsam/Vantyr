import { KeyRound } from "lucide-react";
import { DetailSection } from "@/components/common/resource-detail/DetailSection";
import { KeyValueCard, KeyValueGrid } from "@/components/common/resource-detail/KeyValueCard";
import { ConnectionFacts } from "@/features/devices/components/ConnectionFacts";
import { DeviceDecisions } from "@/features/devices/components/DeviceDecisions";
import { useDevice } from "@/features/devices/deviceContext";
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
    <DetailSection title="Credential" icon={KeyRound}>
      {mine.length === 0 ? (
        <p className="text-sm text-muted-foreground">No credential is issued to this device.</p>
      ) : (
        <KeyValueGrid>
          {mine.map((credential) => (
            <KeyValueCard
              key={credential.id}
              label={
                credential.lastUsedAt ? (
                  <>
                    Last used <TimeAgo iso={credential.lastUsedAt} />
                  </>
                ) : (
                  "Never used"
                )
              }
              format="text"
            >
              <span className={credential.revoked ? "text-muted-foreground" : "text-success"}>
                {credential.revoked ? "Revoked" : "Active"}
              </span>
            </KeyValueCard>
          ))}
        </KeyValueGrid>
      )}
    </DetailSection>
  );
}

/** This device as the Vantyr proxy sees it: the connection, its credential, and what it decided. */
export function DeviceProxyPage() {
  const device = useDevice();
  const proxy = device.connections.proxy;
  return (
    <div className="space-y-8">
      <ConnectionFacts title="Vantyr proxy" connection={proxy} seenLabel="Last request" />
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
