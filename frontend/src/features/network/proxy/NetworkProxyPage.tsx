import { Radio } from "lucide-react";
import { SettingsSection } from "@/features/network/components/SettingsSection";
import { Spinner } from "@vantyr/ui/components/spinner";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import {
  AvailabilityGate,
  UnavailableSection,
} from "@/features/network/components/AvailabilityGate";
import { useNetworkHousehold } from "@/features/network/access/networkScope";
import { useNetworkAdmin } from "@/features/network/access/useNetworkAdmin";
import {
  useProxyAccessQuery,
  useProxyQuery,
} from "@/features/network/runtime/useRuntimeQueries";
import { KeyValueCard, KeyValueGrid } from "@/components/common/resource-detail/KeyValueCard";
import { SettingsPageHeader } from "@/features/settings/components/SettingsLayout";
import { SignInCredentialsCard } from "./CredentialsCard";
import { SessionsCard } from "./SessionsCard";
import { InspectionCard } from "./InspectionCard";

/** Proxy sign-in credentials and sessions, or the standard unavailable state. */
function ProxyAccessSections() {
  const household = useNetworkHousehold();
  const isAdmin = useNetworkAdmin(household.id);
  const query = useProxyAccessQuery();
  if (query.isPending) return null;
  if (query.isError) {
    return (
      <LoadFailedCard
        message="Couldn’t load proxy sign-in."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (query.data.state === "unavailable") {
    return (
      <UnavailableSection title="Sign-in credentials" reason="Proxy sign-in isn’t available on this server yet." />
    );
  }
  const access = query.data.data;
  return (
    <>
      <SignInCredentialsCard household={household.id} access={access} isAdmin={isAdmin} />
      <SessionsCard household={household.id} access={access} isAdmin={isAdmin} />
    </>
  );
}

/** The Vantyr proxy: where it listens, who may use it, and whether HTTPS inspection is on. */
export function NetworkProxyPage() {
  const query = useProxyQuery();
  if (query.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-border/70 bg-card/10 py-12 text-sm text-muted-foreground">
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
      <SettingsPageHeader
        title="Proxy"
        description="Where the proxy listens, who may use it, and whether HTTPS inspection is on. The listener and certificate details are read-only here."
      />
      <AvailabilityGate title="Listener" value={proxy.listener}>
        {(listener) => (
          <SettingsSection title="Listener" icon={<Radio />} variant="plain">
            <KeyValueGrid className="sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3">
              <KeyValueCard label="Address">{listener.address}</KeyValueCard>
              <KeyValueCard label="Accepts" format="text">
                {listener.protocols.map((p) => (p === "connect" ? "CONNECT" : "HTTP")).join(" and ")}
              </KeyValueCard>
              <KeyValueCard label="Destinations" format="text">
                {listener.destinationPolicy}
              </KeyValueCard>
            </KeyValueGrid>
          </SettingsSection>
        )}
      </AvailabilityGate>
      <ProxyAccessSections />
      <AvailabilityGate title="HTTPS inspection" value={proxy.inspection}>
        {(inspection) => <InspectionCard inspection={inspection} />}
      </AvailabilityGate>
    </div>
  );
}
