import { ChevronRight } from "lucide-react";
import { HelpTip } from "@/components/common/HelpTip";
import { useDnsQuery } from "@/features/network/runtime/useRuntimeQueries";

interface PendingItem {
  name: string;
  meaning: string;
}

const MANAGEMENT: PendingItem[] = [
  {
    name: "Encrypted upstreams (DoT/DoH)",
    meaning: "Currently set only in the gateway’s command line or config file, not from here.",
  },
  { name: "Local records", meaning: "Add, edit or remove a local A, AAAA or CNAME record." },
  {
    name: "Cache controls",
    meaning:
      "Clear the cache and test that a name resolves. Only the demo preview can clear the cache for now.",
  },
  { name: "CIDR allow list", meaning: "Edit the address ranges (CIDR) that may ask this server." },
  { name: "Per-device overrides", meaning: "Give one device its own DNS settings." },
  {
    name: "Blocked response mode",
    meaning: "Choose NXDOMAIN, refused or a sinkhole answer for blocked names.",
  },
  { name: "Rate limiting", meaning: "Limit how many queries a client can send." },
  {
    name: "Retention, statistics and query logs",
    meaning: "Choose how long query data is kept and view statistics and logs.",
  },
  { name: "SafeSearch", meaning: "Force safe-search results on supported search engines." },
];

const ADVANCED: PendingItem[] = [
  { name: "DNSSEC", meaning: "Check that answers are signed by the domain’s owner." },
  {
    name: "EDNS client subnet (ECS)",
    meaning:
      "Pass part of a device’s address to upstream servers so they can pick a nearby answer.",
  },
  { name: "AAAA handling", meaning: "Choose whether IPv6 answers are returned to devices." },
];

function Group({ title, items }: { title: string; items: PendingItem[] }) {
  return (
    <div className="px-5 py-4">
      <h4 className="mb-2 text-sm font-medium">{title}</h4>
      <ul className="divide-y divide-border/50">
        {items.map((item) => (
          <li key={item.name} className="flex items-center justify-between gap-4 py-2 text-sm">
            <span className="flex items-center gap-1.5">
              {item.name}
              <HelpTip label={`About ${item.name}`}>{item.meaning}</HelpTip>
            </span>
            <span className="text-[0.8125rem] text-muted-foreground">Not available yet</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The old runtime snapshot of services, categories and SafeSearch. Read-only and not the managed Blocked services card. */
function DemoOnlyServices() {
  const query = useDnsQuery();
  if (!query.data || query.data.state === "unavailable") return null;
  const value = query.data.data.services;
  if (value.state === "unavailable") return null;
  const services = value.data;
  const list = (items: string[] | undefined) =>
    Array.isArray(items) && items.length > 0 ? items.join(", ") : "None";
  const safe =
    typeof services.safeSearch === "boolean"
      ? services.safeSearch
        ? "On"
        : "Off"
      : "Not reported";
  return (
    <div className="px-5 py-4">
      <h4 className="mb-2 flex items-center gap-2 text-sm font-medium">
        Service categories and SafeSearch
        <span className="text-[0.8125rem] font-normal text-muted-foreground">Demo only</span>
      </h4>
      <ul className="divide-y divide-border/50 text-sm">
        {[
          ["Services", list(services.blockedServices)],
          ["Categories", list(services.categories)],
          ["SafeSearch", safe],
        ].map(([label, text]) => (
          <li key={label} className="flex items-center justify-between gap-4 py-2">
            <span>{label}</span>
            <span className="text-[0.8125rem] text-muted-foreground">{text}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        Not enforced by this server. Use Blocked services above to block domains.
      </p>
    </div>
  );
}

/** Everything this server cannot do yet, in one collapsed place so the live settings stay uncluttered. */
export function PendingDnsSection() {
  return (
    <details className="group rounded-xl border border-border/70 bg-card/10">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        Not available yet
      </summary>
      <div className="divide-y divide-border/50 border-t border-border/50">
        <Group title="Management" items={MANAGEMENT} />
        <Group title="Advanced" items={ADVANCED} />
        <DemoOnlyServices />
      </div>
    </details>
  );
}
