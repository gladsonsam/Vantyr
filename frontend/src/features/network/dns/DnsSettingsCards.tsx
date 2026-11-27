import { useState } from "react";
import { Database, FileText, Filter, List, ShieldCheck, type LucideIcon } from "lucide-react";
import { SettingsSection } from "@/features/network/components/SettingsSection";
import RubberSegment from "@/components/react-bits/RubberSegment";
import ScrubField from "@/components/react-bits/ScrubField";
import SquishSwitch from "@/components/react-bits/SquishSwitch";
import WakeSlider from "@/components/react-bits/WakeSlider";
import { matchText } from "@/features/devices/lib/format";
import { useDebouncedCommit } from "@/features/network/lib/useDebouncedCommit";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { HoldAction } from "@/features/network/gateways/HoldAction";
import { useClearDnsCacheMutation } from "@/features/network/runtime/useRuntimeQueries";
import type {
  DnsResponseMode,
  DnsSupportedSettings,
  DnsView,
} from "@/features/network/runtime/types";
import { useDnsSettingsEdit } from "./dnsSettingsEdit";
import { SettingRow } from "./SettingRow";

type Ready<K extends keyof DnsView> = Extract<DnsView[K], { state: "ready" }>["data"];

const UNSUPPORTED_REASON: Record<keyof DnsSupportedSettings, string> = {
  cache: "This server doesn’t manage the DNS cache yet.",
  serveExpired: "This server can’t serve expired answers yet.",
  ttlBounds: "This server doesn’t apply answer lifetime limits yet.",
  rateLimit: "This server doesn’t apply a query rate limit yet.",
  retention: "This server doesn’t set query log retention yet.",
  responseMode: "This server always answers blocked names its own way for now.",
};

/** Stands in for a control the server doesn’t support, so a missing feature never looks adjustable. */
function NotAvailableYet() {
  return <span className="text-sm text-muted-foreground">Not available yet</span>;
}

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

export function FilteringCard({
  filtering,
  supported,
}: {
  filtering: Ready<"filtering">;
  supported: DnsSupportedSettings;
}) {
  const edit = useDnsSettingsEdit();
  const version = edit.version;
  return (
    <Panel title="Filtering">
      <SettingRow
        label="When a domain is blocked"
        description={supported.responseMode ? undefined : UNSUPPORTED_REASON.responseMode}
        help="NXDOMAIN says the name doesn’t exist. Refused says the server won’t answer. A sinkhole answers with an address that goes nowhere."
      >
        {supported.responseMode ? (
          <div
            inert={edit.disabled || undefined}
            className={edit.disabled ? "opacity-50" : undefined}
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
              onChange={(next) => edit.commit({ responseMode: next as DnsResponseMode }, version)}
              trackColor="var(--muted)"
              thumbColor="var(--primary)"
              textColor="var(--muted-foreground)"
              activeTextColor="var(--primary-foreground)"
            />
          </div>
        ) : (
          <NotAvailableYet />
        )}
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

export function CacheCard({
  cache,
  demo,
  supported,
}: {
  cache: Ready<"cache">;
  demo: boolean;
  supported: DnsSupportedSettings;
}) {
  const edit = useDnsSettingsEdit();
  const version = edit.version;
  const clear = useClearDnsCacheMutation();
  const patch = (change: Partial<Ready<"cache">>) => edit.commit({ cache: change }, version);
  const result = clear.data;
  const clearUnavailable = result?.state === "unavailable" ? result.reason : null;
  const canClear = demo && supported.cache && !clearUnavailable && !edit.disabled;
  return (
    <Panel title="Cache">
      <SettingRow
        label="Cache answers"
        description={supported.cache ? undefined : UNSUPPORTED_REASON.cache}
        help="Remembering answers makes repeat lookups instant and reduces what leaves the network."
      >
        {supported.cache ? (
          <SquishSwitch
            {...SWITCH}
            ariaLabel="Cache answers"
            disabled={edit.disabled}
            checked={cache.enabled}
            onChange={(enabled) => patch({ enabled })}
          />
        ) : (
          <NotAvailableYet />
        )}
      </SettingRow>
      <SettingRow
        label="Serve expired answers while refreshing"
        description={supported.serveExpired ? undefined : UNSUPPORTED_REASON.serveExpired}
        help="Keeps names resolving through a short upstream outage, at the risk of briefly stale answers."
      >
        {supported.serveExpired ? (
          <SquishSwitch
            {...SWITCH}
            ariaLabel="Serve expired answers"
            disabled={edit.disabled}
            checked={cache.serveStale}
            onChange={(serveStale) => patch({ serveStale })}
          />
        ) : (
          <NotAvailableYet />
        )}
      </SettingRow>
      <SettingRow
        label="Shortest time to keep an answer"
        description={supported.ttlBounds ? undefined : UNSUPPORTED_REASON.ttlBounds}
      >
        {supported.ttlBounds ? (
          <ScrubField
            {...SCRUB}
            suffix="s"
            min={0}
            max={3600}
            step={5}
            disabled={edit.disabled}
            value={cache.minTtlSeconds}
            onCommit={(minTtlSeconds) => patch({ minTtlSeconds })}
          />
        ) : (
          <NotAvailableYet />
        )}
      </SettingRow>
      <SettingRow
        label="Longest time to keep an answer"
        description={supported.ttlBounds ? undefined : UNSUPPORTED_REASON.ttlBounds}
      >
        {supported.ttlBounds ? (
          <ScrubField
            {...SCRUB}
            suffix="s"
            min={60}
            max={86_400}
            step={60}
            disabled={edit.disabled}
            value={cache.maxTtlSeconds}
            onCommit={(maxTtlSeconds) => patch({ maxTtlSeconds })}
          />
        ) : (
          <NotAvailableYet />
        )}
      </SettingRow>
      <SettingRow
        label="Time to remember “no such name”"
        description={supported.ttlBounds ? undefined : UNSUPPORTED_REASON.ttlBounds}
      >
        {supported.ttlBounds ? (
          <ScrubField
            {...SCRUB}
            suffix="s"
            min={0}
            max={3600}
            step={30}
            disabled={edit.disabled}
            value={cache.negativeTtlSeconds}
            onCommit={(negativeTtlSeconds) => patch({ negativeTtlSeconds })}
          />
        ) : (
          <NotAvailableYet />
        )}
      </SettingRow>
      <SettingRow label="Answers cached now">
        <span className="tabular-nums text-sm text-muted-foreground">
          {cache.entries.toLocaleString()}
        </span>
      </SettingRow>
      <SettingRow
        label="Clear cache"
        help="Forgets every cached answer so names are looked up again. It does not change the settings version."
      >
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span className="text-[0.8125rem] text-muted-foreground" role="status">
            {!demo || !supported.cache || clearUnavailable ? (
              "Not available on this server yet"
            ) : clear.isError ? (
              <span className="text-destructive">
                {clear.error instanceof Error ? clear.error.message : String(clear.error)}
              </span>
            ) : result?.state === "ready" ? (
              <>
                Cache cleared at <TimeAgo iso={result.data.clearedAt} />
                {typeof result.data.entries === "number"
                  ? ` · ${result.data.entries.toLocaleString()} ${result.data.entries === 1 ? "entry" : "entries"}`
                  : null}
                . The settings version did not change.
              </>
            ) : (
              "Hold to clear. The settings version does not change."
            )}
          </span>
          <HoldAction
            ariaLabel="Clear cache"
            doneLabel="Cleared"
            destructive={false}
            disabled={!canClear || clear.isPending}
            onHold={() => clear.mutate()}
          >
            Clear cache
          </HoldAction>
        </div>
      </SettingRow>
    </Panel>
  );
}

export function AccessCard({
  access,
  supported,
}: {
  access: Ready<"access">;
  supported: DnsSupportedSettings;
}) {
  const edit = useDnsSettingsEdit();
  const version = edit.version;
  const shown = access.rateLimitPerSecond ?? 30;
  // A dragged value only holds until the saved setting or its version changes.
  const [draft, setDraft] = useState<{ key: string; value: number } | null>(null);
  const key = `${shown}:${version}`;
  const rate = draft && draft.key === key ? draft.value : shown;
  const setRate = (value: number) => setDraft({ key, value });
  // The commit carries the version the slider was dragged on, not the latest one when the timer fires.
  const save = useDebouncedCommit((change: { value: number; version: number }) =>
    edit.commit({ rateLimitPerSecond: change.value }, change.version),
  );
  return (
    <Panel title="Access">
      <SettingRow
        label="Queries per second, per device"
        description={supported.rateLimit ? undefined : UNSUPPORTED_REASON.rateLimit}
        help="A device asking faster than this is slowed down. It protects the server from a device stuck in a loop."
      >
        {supported.rateLimit ? (
          <WakeSlider
            ariaLabel="Queries per second per device"
            min={1}
            max={200}
            step={1}
            value={rate}
            disabled={edit.disabled}
            onChange={(value) => {
              setRate(value);
              save({ value, version });
            }}
            fillColor="var(--primary)"
            trackColor="var(--muted)"
            formatValue={(value) => `${Math.round(value)}/s`}
          />
        ) : (
          <NotAvailableYet />
        )}
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

export function LoggingCard({
  logging,
  supported,
}: {
  logging: Ready<"logging">;
  supported: DnsSupportedSettings;
}) {
  const edit = useDnsSettingsEdit();
  const version = edit.version;
  return (
    <Panel title="Query log">
      <SettingRow
        label="Keep queries for"
        description={supported.retention ? undefined : UNSUPPORTED_REASON.retention}
        help="Older queries are deleted. The log records domains, not pages, and no request contents."
      >
        {supported.retention ? (
          <ScrubField
            {...SCRUB}
            suffix="days"
            min={1}
            max={30}
            step={1}
            disabled={edit.disabled}
            value={logging.retentionDays}
            onCommit={(retentionDays) => edit.commit({ retentionDays }, version)}
          />
        ) : (
          <NotAvailableYet />
        )}
      </SettingRow>
      <SettingRow label="Keep the device address">
        <span className="text-sm text-muted-foreground">
          {logging.keepClientAddress ? "Yes" : "No"}
        </span>
      </SettingRow>
    </Panel>
  );
}
