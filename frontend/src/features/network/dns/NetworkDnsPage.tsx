import { Spinner } from "@vantyr/ui/components/spinner";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import { useNetworkHousehold } from "@/features/network/access/networkScope";
import { useNetworkAdmin } from "@/features/network/access/useNetworkAdmin";
import {
  AvailabilityGate,
  UnavailableSection,
} from "@/features/network/components/AvailabilityGate";
import { DnsStatusPanel } from "@/features/network/dns-status/DnsStatusPanel";
import type { DnsView } from "@/features/network/runtime/types";
import { useDnsQuery } from "@/features/network/runtime/useRuntimeQueries";
import { SettingsPageHeader } from "@/features/settings/components/SettingsLayout";
import { AccessCard, CacheCard, FilteringCard, LoggingCard } from "./DnsSettingsCards";
import { EncryptedCard, RewritesCard, UpstreamsCard } from "./DnsReadOnlyCards";
import { DnsManagementSections } from "./DnsManagementSections";
import { PendingDnsSection } from "./PendingDnsSection";
import { DnsSettingsNotices, DnsSettingsStatusLine } from "./DnsRuntimeStatus";
import { DnsSettingsEditContext, useDnsSettingsEditState } from "./dnsSettingsEdit";

/** Versioned (compare-and-set) runtime settings: one conflict state for every control on the page. */
function ReadyDnsSections({ dns }: { dns: DnsView }) {
  const edit = useDnsSettingsEditState(dns.settingsVersion);
  const demo = dns.source === "demo";
  return (
    <DnsSettingsEditContext.Provider value={edit}>
      <div className="space-y-3">
        {demo ? (
          <h3 className="text-sm font-medium text-muted-foreground">
            Demo preview — the server doesn’t manage these settings yet
          </h3>
        ) : null}
        <DnsSettingsStatusLine dns={dns} />
        <DnsSettingsNotices />
      </div>
      <AvailabilityGate title="Filtering" value={dns.filtering}>
        {(value) => <FilteringCard filtering={value} />}
      </AvailabilityGate>
      <AvailabilityGate title="Upstream servers" value={dns.upstreams}>
        {(upstreams) => <UpstreamsCard upstreams={upstreams} />}
      </AvailabilityGate>
      <AvailabilityGate title="Local records" value={dns.rewrites}>
        {(rewrites) => <RewritesCard rewrites={rewrites} />}
      </AvailabilityGate>
      <AvailabilityGate title="Encrypted DNS" value={dns.encrypted}>
        {(encrypted) => <EncryptedCard encrypted={encrypted} />}
      </AvailabilityGate>
      <AvailabilityGate title="Cache" value={dns.cache}>
        {(value) => <CacheCard cache={value} demo={demo} />}
      </AvailabilityGate>
      <AvailabilityGate title="Access" value={dns.access}>
        {(value) => <AccessCard access={value} />}
      </AvailabilityGate>
      <AvailabilityGate title="Query log" value={dns.logging}>
        {(value) => <LoggingCard logging={value} />}
      </AvailabilityGate>
    </DnsSettingsEditContext.Provider>
  );
}

/** The other DNS controls, from the runtime snapshot. Unavailable stays unavailable; nothing is faked. */
function RuntimeDnsSections() {
  const query = useDnsQuery();
  if (query.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-border/70 bg-card/10 py-12 text-sm text-muted-foreground">
        <Spinner /> Loading…
      </div>
    );
  }
  if (query.isError) {
    return (
      <LoadFailedCard message="Couldn’t load DNS settings." onRetry={() => void query.refetch()} />
    );
  }
  if (query.data.state === "unavailable") {
    return <UnavailableSection title="Other DNS settings" reason={query.data.reason} />;
  }
  return <ReadyDnsSections dns={query.data.data} />;
}

/** Vantyr DNS settings. Lists and services are saved as desired config; worker reports show what was applied, not verified enforcement. */
export function NetworkDnsPage() {
  const household = useNetworkHousehold();
  const isAdmin = useNetworkAdmin(household.id);
  return (
    <div className="space-y-8">
      <SettingsPageHeader
        title="DNS"
        description="Save desired list and service settings. Worker reports show what was applied; they do not independently verify enforcement."
      />
      <div className="space-y-8">
        {isAdmin ? <DnsManagementSections householdId={household.id} /> : null}
        <DnsStatusPanel householdId={household.id} canManage={isAdmin} />
        <RuntimeDnsSections />
        <PendingDnsSection />
      </div>
    </div>
  );
}
