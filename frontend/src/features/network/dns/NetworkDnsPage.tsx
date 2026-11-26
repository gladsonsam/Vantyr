import { Spinner } from "@vantyr/ui/components/spinner";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import {
  AvailabilityGate,
  UnavailableSection,
} from "@/features/network/components/AvailabilityGate";
import { useDnsQuery } from "@/features/network/runtime/useRuntimeQueries";
import { AccessCard, CacheCard, FilteringCard, ListCard, LoggingCard } from "./DnsSettingsCards";

/** Vantyr DNS settings. A control saves a proposal for gateways; it does not prove they are enforcing it. */
export function NetworkDnsPage() {
  const query = useDnsQuery();
  if (query.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl bg-card py-12 text-sm text-muted-foreground">
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
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <AvailabilityGate title="Filtering" value={dns.filtering}>
          {(value) => <FilteringCard filtering={value} />}
        </AvailabilityGate>
        <AvailabilityGate title="Cache" value={dns.cache}>
          {(value) => <CacheCard cache={value} />}
        </AvailabilityGate>
        <AvailabilityGate title="Blocklist subscriptions" value={dns.lists}>
          {(lists) => (
            <ListCard
              title="Blocklist subscriptions"
              rows={lists.map((l) => ({
                key: l.id,
                left: l.name,
                right: `${l.entries.toLocaleString()} entries`,
              }))}
            />
          )}
        </AvailabilityGate>
      </div>
      <div className="space-y-4">
        <AvailabilityGate title="Access" value={dns.access}>
          {(value) => <AccessCard access={value} />}
        </AvailabilityGate>
        <AvailabilityGate title="Query log" value={dns.logging}>
          {(value) => <LoggingCard logging={value} />}
        </AvailabilityGate>
        <AvailabilityGate title="Upstream servers" value={dns.upstreams}>
          {(upstreams) => (
            <ListCard
              title="Upstream servers"
              rows={upstreams.servers.map((s) => ({
                key: s.address,
                left: s.address,
                right: `${s.protocol.toUpperCase()} · ${s.healthy ? "healthy" : "not answering"}`,
              }))}
            />
          )}
        </AvailabilityGate>
        <AvailabilityGate title="Local records" value={dns.rewrites}>
          {(rewrites) => (
            <ListCard
              title="Local records"
              rows={rewrites.map((r) => ({
                key: r.id,
                left: r.name,
                right: `${r.kind} → ${r.value}`,
              }))}
            />
          )}
        </AvailabilityGate>
        <AvailabilityGate title="Encrypted DNS" value={dns.encrypted}>
          {() => null}
        </AvailabilityGate>
        <AvailabilityGate title="Blocked services and categories" value={dns.services}>
          {() => null}
        </AvailabilityGate>
      </div>
    </div>
  );
}
