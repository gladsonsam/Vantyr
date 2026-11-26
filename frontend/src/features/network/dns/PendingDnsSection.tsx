import { ChevronRight } from "lucide-react";
import { HelpTip } from "@/components/common/HelpTip";

interface PendingItem {
  name: string;
  meaning: string;
}

const MANAGEMENT: PendingItem[] = [
  {
    name: "Blocklist subscriptions",
    meaning:
      "Add or remove a list by URL, refresh it, and see its last check and whether it is stale or failed.",
  },
  { name: "Named service blocking", meaning: "Block a whole service, such as a social network, by name." },
  { name: "Encrypted DNS", meaning: "Turn DNS over HTTPS or TLS on or off and manage its certificate." },
  { name: "Local records", meaning: "Add, edit or remove a local A, AAAA or CNAME record." },
  { name: "Cache controls", meaning: "Clear the cache and test that a name resolves." },
  { name: "Access list", meaning: "Edit the address ranges (CIDR) that may ask this server." },
  { name: "Per-device overrides", meaning: "Give one device its own DNS settings." },
];

const ADVANCED: PendingItem[] = [
  { name: "DNSSEC", meaning: "Check that answers are signed by the domain’s owner." },
  {
    name: "EDNS client subnet (ECS)",
    meaning: "Pass part of a device’s address to upstream servers so they can pick a nearby answer.",
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
      </div>
    </details>
  );
}
