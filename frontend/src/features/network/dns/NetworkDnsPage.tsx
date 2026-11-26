import { Spinner } from "@vantyr/ui/components/spinner";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import {
  AvailabilityGate,
  UnavailableSection,
} from "@/features/network/components/AvailabilityGate";
import { useDnsQuery } from "@/features/network/runtime/useRuntimeQueries";
import { SettingsPageHeader } from "@/features/settings/components/SettingsLayout";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { AccessCard, CacheCard, FilteringCard, ListCard, LoggingCard } from "./DnsSettingsCards";
import { EncryptedCard, RewritesCard, ServicesCard, UpstreamsCard } from "./DnsReadOnlyCards";
import { PendingDnsSection } from "./PendingDnsSection";

/** Vantyr DNS settings. A control saves a proposal for gateways; it does not prove they are enforcing it. */
export function NetworkDnsPage() {
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
    return <UnavailableSection title="DNS" reason={query.data.reason} />;
  }
  const dns = query.data.data;
  return (
    <div className="space-y-8">
      <SettingsPageHeader
        title="DNS"
        description="A change is saved as a proposal. Saved is not applied, and applied is not verified: only a gateway report says what is enforced."
      />
      <div className="space-y-8">
        <AvailabilityGate title="Filtering" value={dns.filtering}>
          {(value) => <FilteringCard filtering={value} />}
        </AvailabilityGate>
        <AvailabilityGate title="Upstream servers" value={dns.upstreams}>
          {(upstreams) => <UpstreamsCard upstreams={upstreams} />}
        </AvailabilityGate>
        <AvailabilityGate title="Blocklist subscriptions" value={dns.lists}>
          {(lists) => (
            <ListCard
              title="Blocklist subscriptions"
              note="Read-only. Adding, removing and refreshing lists is not available on this server yet."
              rows={lists.map((l) => ({
                key: l.id,
                left: l.name,
                right: (
                  <>
                    {l.entries.toLocaleString()} entries ·{" "}
                    {l.error ? (
                      <span className="text-destructive">failed: {l.error}</span>
                    ) : l.lastRefreshedAt ? (
                      <>
                        checked <TimeAgo iso={l.lastRefreshedAt} />
                      </>
                    ) : (
                      "never checked"
                    )}
                  </>
                ),
              }))}
            />
          )}
        </AvailabilityGate>
        <AvailabilityGate title="Blocked services and categories" value={dns.services}>
          {(services) => <ServicesCard services={services} />}
        </AvailabilityGate>
        <AvailabilityGate title="Local records" value={dns.rewrites}>
          {(rewrites) => <RewritesCard rewrites={rewrites} />}
        </AvailabilityGate>
        <AvailabilityGate title="Encrypted DNS" value={dns.encrypted}>
          {(encrypted) => <EncryptedCard encrypted={encrypted} />}
        </AvailabilityGate>
        <AvailabilityGate title="Cache" value={dns.cache}>
          {(value) => <CacheCard cache={value} />}
        </AvailabilityGate>
        <AvailabilityGate title="Access" value={dns.access}>
          {(value) => <AccessCard access={value} />}
        </AvailabilityGate>
        <AvailabilityGate title="Query log" value={dns.logging}>
          {(value) => <LoggingCard logging={value} />}
        </AvailabilityGate>
        <PendingDnsSection />
      </div>
    </div>
  );
}
