import { useState, type ReactNode } from "react";
import { Database, FileText, Filter, List, ShieldCheck, type LucideIcon } from "lucide-react";
import { SettingsSection } from "@/features/network/components/SettingsSection";
import RubberSegment from "@/components/react-bits/RubberSegment";
import ScrubField from "@/components/react-bits/ScrubField";
import SquishSwitch from "@/components/react-bits/SquishSwitch";
import WakeSlider from "@/components/react-bits/WakeSlider";
import { matchText } from "@/features/devices/lib/format";
import { useDebouncedCommit } from "@/features/network/lib/useDebouncedCommit";
import { useUpdateDnsMutation } from "@/features/network/runtime/useRuntimeQueries";
import type { DnsResponseMode, DnsView } from "@/features/network/runtime/types";
import { Button } from "@vantyr/ui/components/button";
import { SettingRow } from "./SettingRow";

type Ready<K extends keyof DnsView> = Extract<DnsView[K], { state: "ready" }>["data"];

const SWITCH = {
  trackColor: "var(--muted)",
  trackOnColor: "var(--primary)",
  thumbColor: "var(--foreground)",
  thumbOnColor: "var(--primary-foreground)",
} as const;

const SCRUB = { accent: "var(--primary)", chipColor: "var(--muted)", label: "↔" } as const;

const PANEL_ICON: Record<string, LucideIcon> = {
  Filtering: Filter,
  Cache: Database,
  Access: ShieldCheck,
  "Query log": FileText,
};

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  const Icon = PANEL_ICON[title] ?? List;
  return (
    <SettingsSection title={title} icon={<Icon />}>
      {children}
    </SettingsSection>
  );
}

export function FilteringCard({ filtering }: { filtering: Ready<"filtering"> }) {
  const update = useUpdateDnsMutation();
  return (
    <Panel title="Filtering">
      <SettingRow
        label="When a domain is blocked"
        help="NXDOMAIN says the name doesn’t exist. Refused says the server won’t answer. A sinkhole answers with an address that goes nowhere."
      >
        <RubberSegment
          aria-label="Blocked response"
          size="sm"
          items={[
            { value: "nxdomain", label: "NXDOMAIN" },
            { value: "refused", label: "Refused" },
            { value: "sinkhole", label: "Sinkhole" },
          ]}
          value={filtering.responseMode}
          onChange={(next) => update.mutate({ responseMode: next as DnsResponseMode })}
          trackColor="var(--muted)"
          thumbColor="var(--primary)"
          textColor="var(--muted-foreground)"
          activeTextColor="var(--primary-foreground)"
        />
      </SettingRow>
      <SettingRow label="Always allowed">
        <span className="font-mono text-[0.8125rem]">
          {filtering.allow.length === 0 ? "None" : filtering.allow.map(matchText).join(", ")}
        </span>
      </SettingRow>
      <SettingRow label="Blocked by rule">
        <span className="font-mono text-[0.8125rem]">
          {filtering.block.length === 0 ? "None" : filtering.block.map(matchText).join(", ")}
        </span>
      </SettingRow>
    </Panel>
  );
}

export function CacheCard({ cache }: { cache: Ready<"cache"> }) {
  const update = useUpdateDnsMutation();
  const patch = (change: Partial<Ready<"cache">>) => update.mutate({ cache: change });
  return (
    <Panel title="Cache">
      <SettingRow
        label="Cache answers"
        help="Remembering answers makes repeat lookups instant and reduces what leaves the network."
      >
        <SquishSwitch
          {...SWITCH}
          ariaLabel="Cache answers"
          checked={cache.enabled}
          onChange={(enabled) => patch({ enabled })}
        />
      </SettingRow>
      <SettingRow
        label="Serve expired answers while refreshing"
        help="Keeps names resolving through a short upstream outage, at the risk of briefly stale answers."
      >
        <SquishSwitch
          {...SWITCH}
          ariaLabel="Serve expired answers"
          checked={cache.serveStale}
          onChange={(serveStale) => patch({ serveStale })}
        />
      </SettingRow>
      <SettingRow label="Shortest time to keep an answer">
        <ScrubField
          {...SCRUB}
          suffix="s"
          min={0}
          max={3600}
          step={5}
          value={cache.minTtlSeconds}
          onCommit={(minTtlSeconds) => patch({ minTtlSeconds })}
        />
      </SettingRow>
      <SettingRow label="Longest time to keep an answer">
        <ScrubField
          {...SCRUB}
          suffix="s"
          min={60}
          max={86_400}
          step={60}
          value={cache.maxTtlSeconds}
          onCommit={(maxTtlSeconds) => patch({ maxTtlSeconds })}
        />
      </SettingRow>
      <SettingRow label="Time to remember “no such name”">
        <ScrubField
          {...SCRUB}
          suffix="s"
          min={0}
          max={3600}
          step={30}
          value={cache.negativeTtlSeconds}
          onCommit={(negativeTtlSeconds) => patch({ negativeTtlSeconds })}
        />
      </SettingRow>
      <SettingRow label="Answers cached now">
        <span className="tabular-nums text-sm text-muted-foreground">
          {cache.entries.toLocaleString()}
        </span>
      </SettingRow>
      <SettingRow
        label="Clear cache"
        help="Forgets every cached answer so names are looked up again. The server has no way to do this yet."
      >
        <div className="flex items-center gap-3">
          <span className="text-[0.8125rem] text-muted-foreground">
            Not available on this server yet
          </span>
          <Button variant="outline" size="sm" disabled>
            Clear cache
          </Button>
        </div>
      </SettingRow>
    </Panel>
  );
}

export function AccessCard({ access }: { access: Ready<"access"> }) {
  const update = useUpdateDnsMutation();
  const [rate, setRate] = useState(access.rateLimitPerSecond ?? 30);
  const save = useDebouncedCommit((value: number) => update.mutate({ rateLimitPerSecond: value }));
  return (
    <Panel title="Access">
      <SettingRow
        label="Queries per second, per device"
        help="A device asking faster than this is slowed down. It protects the server from a device stuck in a loop."
      >
        <WakeSlider
          ariaLabel="Queries per second per device"
          min={1}
          max={200}
          step={1}
          value={rate}
          onChange={(value) => {
            setRate(value);
            save(value);
          }}
          fillColor="var(--primary)"
          trackColor="var(--muted)"
          formatValue={(value) => `${Math.round(value)}/s`}
        />
      </SettingRow>
      <SettingRow
        label="Who may ask"
        help="Read-only. Editing the allowed address ranges is not available on this server yet."
      >
        <span className="font-mono text-[0.8125rem]">
          {access.allowedClients.length === 0 ? "None listed" : access.allowedClients.join(", ")}
        </span>
      </SettingRow>
    </Panel>
  );
}

export function LoggingCard({ logging }: { logging: Ready<"logging"> }) {
  const update = useUpdateDnsMutation();
  return (
    <Panel title="Query log">
      <SettingRow
        label="Keep queries for"
        help="Older queries are deleted. The log records domains, not pages, and no request contents."
      >
        <ScrubField
          {...SCRUB}
          suffix="days"
          min={1}
          max={30}
          step={1}
          value={logging.retentionDays}
          onCommit={(retentionDays) => update.mutate({ retentionDays })}
        />
      </SettingRow>
      <SettingRow label="Keep the device address">
        <span className="text-sm text-muted-foreground">
          {logging.keepClientAddress ? "Yes" : "No"}
        </span>
      </SettingRow>
    </Panel>
  );
}

export function ListCard({
  title,
  rows,
  note,
}: {
  title: string;
  rows: { key: string; left: string; right: ReactNode }[];
  note?: ReactNode;
}) {
  if (rows.length === 0) {
    return (
      <Panel title={title}>
        {note ? <p className="px-5 py-3 text-[0.8125rem] text-muted-foreground">{note}</p> : null}
        <p className="px-5 py-4 text-sm text-muted-foreground">Nothing listed.</p>
      </Panel>
    );
  }
  return (
    <Panel title={title}>
      {note ? <p className="px-5 py-3 text-[0.8125rem] text-muted-foreground">{note}</p> : null}
      {rows.map((row) => (
        <SettingRow key={row.key} label={row.left}>
          <span className="text-right text-[0.8125rem] text-muted-foreground">{row.right}</span>
        </SettingRow>
      ))}
    </Panel>
  );
}
