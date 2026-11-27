import { Fragment, useContext, useId, useMemo, useState } from "react";
import { useHref, useParams, useSearchParams } from "react-router-dom";
import { Activity, ShieldOff } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Input } from "@vantyr/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { Spinner } from "@vantyr/ui/components/spinner";
import { isApiError } from "@/api";
import { usePageHeader } from "@/app/shell/usePageHeader";
import { CopyTextButton } from "@/components/common/CopyTextButton";
import { EmptyState } from "@/components/common/EmptyState";
import { HelpTip } from "@/components/common/HelpTip";
import RubberSegment from "@/components/react-bits/RubberSegment";
import { useDeviceRows } from "@/features/devices/hooks/useDeviceRows";
import { useNetworkHousehold } from "@/features/network/access/networkScope";
import { useNetworkAdmin } from "@/features/network/access/useNetworkAdmin";
import { UnavailableSection } from "@/features/network/components/AvailabilityGate";
import { PageLoading } from "@/features/network/components/PageLoading";
import { useDebouncedCommit } from "@/features/network/lib/useDebouncedCommit";
import { createHttpRuntime } from "@/features/network/runtime/httpRuntime";
import {
  NetworkRuntimeContext,
  unavailableRuntime,
} from "@/features/network/runtime/NetworkRuntimeSource";
import { useDnsStatsQuery } from "@/features/network/runtime/useRuntimeQueries";
import type { Effect, EventsGrouping, NetworkEvent } from "@/features/network/runtime/types";
import { SettingsPageHeader } from "@/features/settings/components/SettingsLayout";
import { fmtDayLabel, parseTimestamp } from "@/lib/utils";
import { ActivityRow } from "./ActivityRow";
import { ActivityStats } from "./ActivityStats";
import { EvidenceHelp } from "./EvidenceLabel";
import {
  groupingSupported,
  NOT_AVAILABLE_YET,
  sourceSupported,
  unsupportedSourceText,
  WINDOW_TOO_OLD,
} from "./evidenceLib";
import { RetentionLine } from "./RetentionLine";
import { useActivityEvents, useResetActivityEvents } from "./useActivityEvents";

const UNAVAILABLE = "Query history isn’t available on this server yet.";
const PAGE_SIZES = ["25", "50", "100"] as const;
const SOURCES = ["all", "dns", "proxy", "agent"] as const;
const SOURCE_LABEL: Record<(typeof SOURCES)[number], string> = {
  all: "All sources",
  dns: "DNS",
  proxy: "Proxy",
  agent: "Agent",
};
type SourceFilter = (typeof SOURCES)[number];
/** The device filter's value for clients that map to no known device. */
const UNRECOGNISED = "__unrecognised__";
type DecisionFilter = "all" | Effect;

function initialSource(value: string | null): SourceFilter {
  return (SOURCES as readonly string[]).includes(value ?? "") ? (value as SourceFilter) : "all";
}

function initialDecision(value: string | null): DecisionFilter {
  if (value === "allowed" || value === "allow") return "allow";
  if (value === "blocked" || value === "deny") return "deny";
  return "all";
}

/** `datetime-local` value (browser local time) to an RFC3339 UTC instant; null when empty/invalid. */
function toInstant(value: string, endOfMinute: boolean): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (endOfMinute) date.setSeconds(59, 999);
  return date.toISOString();
}

function dayOf(event: NetworkEvent): { key: string; label: string } {
  const date = parseTimestamp(event.at);
  return date
    ? { key: date.toDateString(), label: fmtDayLabel(date) }
    : { key: "unknown", label: "Unknown date" };
}

const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_PERMISSION = "You need the Network events permission for this household.";

/**
 * Every domain or host a gateway observed for this household, newest first. Rows are observations,
 * not visits; the list says how long it is kept and never implies it reaches further back.
 */
export function NetworkActivityPage() {
  const { rows: deviceRows } = useDeviceRows();
  const household = useNetworkHousehold();
  const isAdmin = useNetworkAdmin(household.id);
  const href = useHref(`/network/activity/${household.id}`);
  const deviceOptions = useMemo(
    () =>
      deviceRows
        .filter((row) => row.deviceId)
        .map((row) => ({ id: row.deviceId as string, label: row.label, key: row.key })),
    [deviceRows],
  );
  return (
    <ActivityContent
      deviceOptions={deviceOptions}
      scopedLink={isAdmin ? new URL(href, window.location.origin).href : null}
    />
  );
}

/**
 * Events-only Activity for one household, addressed by the id in the URL and outside the
 * administrator-only Network layout. It calls only the DNS events and statistics reads, never
 * households or inventory, so a person with just the Network events permission can use it.
 */
export function ScopedActivityPage({ householdId }: { householdId: string }) {
  usePageHeader({
    title: "Activity",
    description: "Domains the DNS workers observed for this household.",
  });
  const inherited = useContext(NetworkRuntimeContext);
  const http = useMemo(() => createHttpRuntime(householdId), [householdId]);
  const runtime = inherited !== unavailableRuntime ? inherited : http;
  return (
    <NetworkRuntimeContext.Provider value={runtime}>
      <div className="mx-auto w-full max-w-5xl">
        <ActivityContent scoped deviceOptions={null} scopedLink={null} />
      </div>
    </NetworkRuntimeContext.Provider>
  );
}

/** Route element for `/network/activity/:householdId`. */
export function ScopedActivityRoute() {
  const { householdId = "" } = useParams();
  return <ScopedActivityPage householdId={householdId} />;
}

function ActivityContent({
  scoped = false,
  deviceOptions,
  scopedLink,
}: {
  scoped?: boolean;
  /** Household devices for the filter; `null` in scoped mode, which never reads the inventory. */
  deviceOptions: { id: string; label: string; key: string }[] | null;
  /** The events-only page's URL, for administrators to copy. */
  scopedLink: string | null;
}) {
  const ids = useId();
  const [params] = useSearchParams();
  const resetEvents = useResetActivityEvents();
  const householdStats = useDnsStatsQuery({ range: "24h" });
  const [deviceDraft, setDeviceDraft] = useState(params.get("device") ?? "");

  const [device, setDevice] = useState(params.get("device") ?? "all");
  const commitDevice = (value: string) => {
    const id = value.trim();
    setDevice(id === "" ? "all" : DEVICE_ID.test(id) ? id.toLowerCase() : "all");
  };
  const [source, setSource] = useState<SourceFilter>(initialSource(params.get("source")));
  const [decision, setDecision] = useState<DecisionFilter>(initialDecision(params.get("decision")));
  const [searchDraft, setSearchDraft] = useState(params.get("q") ?? "");
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [fromValue, setFromValue] = useState("");
  const [toValue, setToValue] = useState("");
  const [grouping, setGrouping] = useState<EventsGrouping>("raw");
  const [pageSize, setPageSize] = useState<string>("50");
  const commitSearch = useDebouncedCommit<string>(setSearch);

  const from = toInstant(fromValue, false);
  const to = toInstant(toValue, true);
  const rangeProblem = from && to && from > to ? "“From” must be before or equal to “To”." : null;

  const eventsQuery = useMemo(
    () => ({
      deviceId: device === "all" || device === UNRECOGNISED ? undefined : device,
      unrecognisedDevices: device === UNRECOGNISED ? true : undefined,
      source,
      decision,
      search: search.trim() || undefined,
      from: rangeProblem ? undefined : (from ?? undefined),
      to: rangeProblem ? undefined : (to ?? undefined),
      grouping,
      limit: Number(pageSize),
    }),
    [device, source, decision, search, from, to, rangeProblem, grouping, pageSize],
  );
  const list = useActivityEvents(eventsQuery);

  const filtered =
    device !== "all" ||
    source !== "all" ||
    decision !== "all" ||
    Boolean(search.trim() || fromValue || toValue);
  const clearFilters = () => {
    setDevice("all");
    setDeviceDraft("");
    setSource("all");
    setDecision("all");
    setSearchDraft("");
    setSearch("");
    setFromValue("");
    setToValue("");
  };

  const header = (
    <SettingsPageHeader
      title="Activity"
      description="Domains and hosts the gateways observed for this household."
      actions={
        scopedLink ? <CopyTextButton text={scopedLink} label="Copy events link" /> : undefined
      }
    />
  );
  const failure = list.error;
  const code = isApiError(failure) ? failure.status : 0;
  if (scoped && !list.data && (code === 401 || code === 403 || code === 404)) {
    return (
      <EmptyState
        title={NO_PERMISSION}
        description="Ask a network administrator to grant it."
        icon={<ShieldOff className="size-5" />}
        iconVariant="icon"
      />
    );
  }

  if (list.isPending) {
    return (
      <div className="space-y-6">
        {header}
        <PageLoading />
      </div>
    );
  }
  if (list.isError && !list.data) {
    return (
      <div className="space-y-6">
        {header}
        <UnavailableSection title="Activity" reason="Couldn’t load activity." />
      </div>
    );
  }
  const pages = list.data.pages;
  const firstPage = pages[0];
  if (firstPage.state === "unavailable") {
    return (
      <div className="space-y-6">
        {header}
        <UnavailableSection title="Activity" reason={firstPage.reason || UNAVAILABLE} />
        {filtered ? (
          <Button variant="outline" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : null}
      </div>
    );
  }

  const seen = new Set<string>();
  const events: NetworkEvent[] = [];
  for (const page of pages) {
    if (page.state !== "ready") continue;
    for (const event of page.data.events) {
      // Rows can shift across a page boundary while new ones arrive; show each one once.
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      events.push(event);
    }
  }
  const lastPage = pages[pages.length - 1];
  const total = lastPage.state === "ready" ? lastPage.data.total : null;
  const hasMore = list.hasNextPage;
  const stale = list.isPlaceholderData;

  const days: { key: string; label: string; events: NetworkEvent[] }[] = [];
  for (const event of events) {
    const day = dayOf(event);
    const tail = days[days.length - 1];
    if (tail?.key === day.key) tail.events.push(event);
    else days.push({ ...day, events: [event] });
  }

  const capabilities = firstPage.data.capabilities;
  const sourceMissing = !sourceSupported(capabilities, source);
  const groupingMissing = !groupingSupported(capabilities, grouping);
  const someSourcesMissing = SOURCES.some(
    (value) => value !== "all" && !sourceSupported(capabilities, value),
  );
  const windowTooOld =
    list.isFetchNextPageError && isApiError(list.error) && list.error.status === 400;
  const unrecognisedMissing = capabilities.unrecognisedFilter === false;
  // Labels for device ids: the household devices, or (scoped) only what the loaded rows carry.
  const deviceLabels = new Map<string, string>();
  for (const event of events) {
    if (event.deviceId) deviceLabels.set(event.deviceId, event.deviceLabel);
  }
  for (const option of deviceOptions ?? []) deviceLabels.set(option.id, option.label);
  const scopedChoices = new Map(deviceLabels);
  if (householdStats.data?.state === "ready") {
    for (const entry of householdStats.data.data.topDevices ?? []) {
      if (!scopedChoices.has(entry.deviceId)) scopedChoices.set(entry.deviceId, "");
    }
  }
  const fieldLabel = "text-xs font-medium text-muted-foreground";
  return (
    <div className="space-y-6">
      {header}
      {device === UNRECOGNISED ? null : (
        <ActivityStats
          deviceId={device === "all" ? undefined : device}
          deviceLabels={deviceLabels}
        />
      )}

      <div className="space-y-4 rounded-xl border border-border/70 bg-card/10 p-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-device`} className={fieldLabel}>
              Device
            </label>
            {deviceOptions === null ? (
              <>
                <Input
                  id={`${ids}-device`}
                  value={deviceDraft}
                  list={`${ids}-device-list`}
                  placeholder="Device id (all devices when empty)"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={deviceDraft.trim() !== "" && !DEVICE_ID.test(deviceDraft.trim())}
                  onChange={(event) => {
                    setDeviceDraft(event.target.value);
                    commitDevice(event.target.value);
                  }}
                />
                <datalist id={`${ids}-device-list`}>
                  {[...scopedChoices].map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </datalist>
              </>
            ) : (
              <Select value={device} onValueChange={(value) => setDevice(value as string)}>
                <SelectTrigger id={`${ids}-device`} className="w-full" aria-label="Device">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All devices</SelectItem>
                  <SelectItem value={UNRECOGNISED} disabled={unrecognisedMissing}>
                    Unrecognised devices
                    {unrecognisedMissing ? (
                      <span className="text-xs text-muted-foreground">{NOT_AVAILABLE_YET}</span>
                    ) : null}
                  </SelectItem>
                  {deviceOptions.map((row) => (
                    <SelectItem key={row.key} value={row.id}>
                      {row.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-source`} className={fieldLabel}>
              Source
            </label>
            <Select value={source} onValueChange={(value) => setSource(value as SourceFilter)}>
              <SelectTrigger id={`${ids}-source`} className="w-full" aria-label="Source">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCES.map((value) => (
                  <SelectItem
                    key={value}
                    value={value}
                    disabled={!sourceSupported(capabilities, value)}
                  >
                    {SOURCE_LABEL[value]}
                    {sourceSupported(capabilities, value) ? null : (
                      <span className="text-xs text-muted-foreground">{NOT_AVAILABLE_YET}</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-decision`} className={fieldLabel}>
              Decision
            </label>
            <Select
              value={decision}
              onValueChange={(value) => setDecision(value as DecisionFilter)}
            >
              <SelectTrigger id={`${ids}-decision`} className="w-full" aria-label="Decision">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Allowed and blocked</SelectItem>
                <SelectItem value="allow">Allowed</SelectItem>
                <SelectItem value="deny">Blocked</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-search`} className={fieldLabel}>
              Search host
            </label>
            <Input
              id={`${ids}-search`}
              value={searchDraft}
              maxLength={128}
              placeholder="e.g. video.example"
              autoComplete="off"
              onChange={(event) => {
                setSearchDraft(event.target.value);
                commitSearch(event.target.value);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-from`} className={fieldLabel}>
              From
            </label>
            <Input
              id={`${ids}-from`}
              type="datetime-local"
              value={fromValue}
              max={toValue || undefined}
              aria-invalid={Boolean(rangeProblem)}
              onChange={(event) => setFromValue(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-to`} className={fieldLabel}>
              To
            </label>
            <Input
              id={`${ids}-to`}
              type="datetime-local"
              value={toValue}
              min={fromValue || undefined}
              aria-invalid={Boolean(rangeProblem)}
              onChange={(event) => setToValue(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <span className={fieldLabel}>Group</span>
            <div className="space-y-1">
              <RubberSegment
                aria-label="Grouping"
                items={[
                  { value: "raw", label: "Each lookup" },
                  { value: "by_host", label: "By host" },
                ]}
                value={grouping}
                onChange={(next) => setGrouping(next as EventsGrouping)}
                size="sm"
                disabled={!capabilities.grouping.includes("by_host")}
                trackColor="var(--muted)"
                thumbColor="var(--primary)"
                textColor="var(--muted-foreground)"
                activeTextColor="var(--primary-foreground)"
              />
              {capabilities.grouping.includes("by_host") ? null : (
                <p className="text-xs text-muted-foreground">
                  Grouping by host: {NOT_AVAILABLE_YET.toLowerCase()}
                </p>
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-size`} className={fieldLabel}>
              Per page
            </label>
            <Select value={pageSize} onValueChange={(value) => setPageSize(value as string)}>
              <SelectTrigger id={`${ids}-size`} className="w-full" aria-label="Rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((size) => (
                  <SelectItem key={size} value={size}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {rangeProblem ? (
          <p role="alert" className="text-xs text-destructive">
            {rangeProblem}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button variant="outline" disabled={!filtered} onClick={clearFilters}>
            Clear filters
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="flex items-center gap-1 text-sm text-muted-foreground" aria-live="polite">
          {total === null || total === undefined
            ? `Showing ${events.length.toLocaleString()}`
            : `Showing ${events.length.toLocaleString()} of ${total.toLocaleString()}`}
          <HelpTip label="About activity">
            Rows are domains and hosts a gateway observed, not browser history. Counts are
            observations, not visits or page views, and only hostnames are kept, never full URLs. A
            missing event means no observations were received, never that a device was protected.
            Allowed is a policy decision, not proof a lookup was answered.
          </HelpTip>
          <EvidenceHelp />
        </p>
        <RetentionLine page={firstPage.data} />
      </div>

      {sourceMissing && source !== "all" ? (
        <EmptyState
          title={unsupportedSourceText(source)}
          description="This server doesn’t record it yet. That is not the same as nothing happening."
          icon={<Activity className="size-5" />}
          iconVariant="icon"
        />
      ) : groupingMissing ? (
        <EmptyState
          title="Grouping by host isn’t available yet"
          description="Switch back to each lookup to see activity."
          icon={<Activity className="size-5" />}
          iconVariant="icon"
        />
      ) : days.length === 0 ? (
        <EmptyState
          title="No activity matches these filters"
          description={
            filtered ? "Try a wider date range or fewer filters." : "Nothing has been observed yet."
          }
          icon={<Activity className="size-5" />}
          iconVariant="icon"
          action={
            filtered ? (
              <Button variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div
          className="overflow-hidden rounded-xl border border-border/70 bg-card/10 data-[stale=true]:opacity-60"
          data-stale={stale}
          aria-busy={stale}
        >
          {days.map((day) => (
            <Fragment key={day.key}>
              <h3 className="border-b border-border/70 px-4 py-2 text-xs font-medium text-muted-foreground">
                {day.label}
              </h3>
              <ul aria-label={`Activity, ${day.label}`}>
                {day.events.map((event) => (
                  <ActivityRow key={event.id} event={event} grouped={grouping === "by_host"} />
                ))}
              </ul>
            </Fragment>
          ))}
        </div>
      )}

      {source === "all" && someSourcesMissing ? (
        <p className="text-xs text-muted-foreground">
          Only{" "}
          {SOURCES.filter((value) => value !== "all" && sourceSupported(capabilities, value))
            .map((value) => SOURCE_LABEL[value])
            .join(" and ")}{" "}
          history is recorded on this server yet.
        </p>
      ) : null}

      {windowTooOld ? (
        <div className="flex flex-wrap items-center justify-center gap-3" role="alert">
          <p className="text-sm text-muted-foreground">{WINDOW_TOO_OLD}</p>
          <Button variant="outline" onClick={resetEvents}>
            Refresh
          </Button>
        </div>
      ) : hasMore ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {list.isFetchingNextPage ? <Spinner /> : null}
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
