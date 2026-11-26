import { Card, CardContent } from "@vantyr/ui/components/card";
import { Spinner } from "@vantyr/ui/components/spinner";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import {
  AvailabilityGate,
  UnavailableSection,
} from "@/features/network/components/AvailabilityGate";
import { useProxyQuery } from "@/features/network/runtime/useRuntimeQueries";
import { CredentialsCard } from "./CredentialsCard";
import { InspectionCard } from "./InspectionCard";

/** The Vantyr proxy: where it listens, who may use it, and whether HTTPS inspection is on. */
export function NetworkProxyPage() {
  const query = useProxyQuery();
  if (query.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl bg-card py-12 text-sm text-muted-foreground">
        <Spinner /> Loading…
      </div>
    );
  }
  if (query.isError) {
    return (
      <LoadFailedCard message="Couldn’t load the proxy." onRetry={() => void query.refetch()} />
    );
  }
  if (query.data.state === "unavailable") {
    return <UnavailableSection title="Proxy" reason={query.data.reason} />;
  }
  const proxy = query.data.data;
  return (
    <div className="space-y-8">
      <AvailabilityGate title="Listener" value={proxy.listener}>
        {(listener) => (
          <Card className="gap-0 py-0">
            <CardContent className="space-y-3 p-5">
              <h3 className="font-medium">Listener</h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Address</dt>
                <dd className="font-mono text-[0.8125rem]">{listener.address}</dd>
                <dt className="text-muted-foreground">Accepts</dt>
                <dd>
                  {listener.protocols
                    .map((p) => (p === "connect" ? "CONNECT" : "HTTP"))
                    .join(" and ")}
                </dd>
                <dt className="text-muted-foreground">Destinations</dt>
                <dd>{listener.destinationPolicy}</dd>
              </dl>
            </CardContent>
          </Card>
        )}
      </AvailabilityGate>
      <AvailabilityGate title="Credentials" value={proxy.credentials}>
        {(credentials) => <CredentialsCard credentials={credentials} />}
      </AvailabilityGate>
      <AvailabilityGate title="HTTPS inspection" value={proxy.inspection}>
        {(inspection) => <InspectionCard inspection={inspection} />}
      </AvailabilityGate>
    </div>
  );
}
