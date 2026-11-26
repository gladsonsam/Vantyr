import { useState } from "react";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { HelpTip } from "@/components/common/HelpTip";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@vantyr/ui/components/input-group";
import RubberSegment from "@/components/react-bits/RubberSegment";
import { sourceSupported, unsupportedSourceText } from "@/features/network/activity/evidenceLib";
import { RetentionLine } from "@/features/network/activity/RetentionLine";
import { UnavailableSection } from "@/features/network/components/AvailabilityGate";
import { useDebouncedCommit } from "@/features/network/lib/useDebouncedCommit";
import { useEventsQuery } from "@/features/network/runtime/useRuntimeQueries";
import type { Effect, EventSource } from "@/features/network/runtime/types";
import { fmtDateTime } from "@/lib/utils";
import { cn } from "@/lib/utils";

const PAGE = 8;
type ResultFilter = "all" | Effect;

const COPY = {
  dns: {
    title: "Recent lookups",
    helpLabel: "About the lookup log",
    help: "Each row is a domain name a gateway observed, with its decision. It is not browser history or a record of pages visited, and only hostnames are kept, never full URLs.",
    placeholder: "Search domains…",
    searchLabel: "Search the lookup log",
    unavailable: "Lookup log",
    failed: "Couldn’t load the lookup log.",
    empty: "No lookups match.",
  },
  proxy: {
    title: "Recent requests",
    helpLabel: "About the request log",
    help: "Each row is a destination host the proxy observed, with its decision. It is not browser history or a record of pages visited, and only hostnames are kept, never full URLs.",
    placeholder: "Search hosts…",
    searchLabel: "Search the request log",
    unavailable: "Request log",
    failed: "Couldn’t load the request log.",
    empty: "No requests match.",
  },
} as const;

/** Every DNS (or proxy) decision for this device, newest first, searchable and filterable. */
export function QueryLog({
  deviceId,
  source = "dns",
}: {
  deviceId: string;
  source?: Extract<EventSource, "dns" | "proxy">;
}) {
  const copy = COPY[source];
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [result, setResult] = useState<ResultFilter>("all");
  const [page, setPage] = useState(0);
  const commitSearch = useDebouncedCommit<string>((value) => {
    setAppliedSearch(value);
    setPage(0);
  });
  const query = useEventsQuery({
    deviceId,
    source,
    search: appliedSearch.trim() || undefined,
    decision: result,
    limit: PAGE,
    offset: page * PAGE,
  });

  const data = query.data?.state === "ready" ? query.data.data : null;
  const events = data?.events ?? [];
  const total = data?.total ?? null;
  const unsupported = data ? !sourceSupported(data.capabilities, source) : false;
  const first = page * PAGE + 1;
  const last = page * PAGE + events.length;

  return (
    <div className="space-y-5 rounded-xl border border-border/70 bg-card/10 p-5">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h3 className="flex items-center gap-1 font-medium">
            {copy.title}
            <HelpTip label={copy.helpLabel}>{copy.help}</HelpTip>
          </h3>
          <div className="flex flex-wrap items-center gap-3">
            <RubberSegment
              aria-label="Show"
              items={[
                { value: "all", label: "All" },
                { value: "allow", label: "Allowed" },
                { value: "deny", label: "Blocked" },
              ]}
              value={result}
              onChange={(next) => {
                setResult(next as ResultFilter);
                setPage(0);
              }}
              size="sm"
              trackColor="var(--muted)"
              thumbColor="var(--primary)"
              textColor="var(--muted-foreground)"
              activeTextColor="var(--primary-foreground)"
            />
            <InputGroup className="w-56">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  commitSearch(event.target.value);
                }}
                placeholder={copy.placeholder}
                aria-label={copy.searchLabel}
              />
            </InputGroup>
          </div>
        </div>

        {query.data?.state === "unavailable" ? (
          <UnavailableSection title={copy.unavailable} reason={query.data.reason} />
        ) : query.isError ? (
          <UnavailableSection title={copy.unavailable} reason={copy.failed} />
        ) : unsupported ? (
          <p className="py-6 text-sm text-muted-foreground">{unsupportedSourceText(source)}</p>
        ) : events.length === 0 && !query.isPending ? (
          <p className="py-6 text-sm text-muted-foreground">{copy.empty}</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {events.map((event) => {
              const blocked = event.effect === "deny";
              return (
                <li
                  key={event.id}
                  className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-0.5 py-2.5 text-sm sm:grid-cols-[9rem_1fr_6rem_minmax(0,12rem)]"
                >
                  <span className="whitespace-nowrap text-muted-foreground">
                    {fmtDateTime(event.at)}
                  </span>
                  <span className="min-w-0 truncate font-mono text-[0.8125rem]">
                    {event.subject}
                  </span>
                  <span
                    className={cn(
                      "flex items-center gap-1.5 font-medium",
                      blocked ? "text-destructive" : "text-success",
                    )}
                  >
                    <span
                      className={cn("size-1.5 rounded-full", blocked ? "bg-destructive" : "bg-success")}
                    />
                    {blocked ? "Blocked" : "Allowed"}
                  </span>
                  <span className="col-span-3 truncate text-xs text-muted-foreground sm:col-span-1">
                    {event.reason} · r{event.revision}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {data ? <RetentionLine page={data} /> : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {events.length > 0 ? (
              <span aria-live="polite">
                {first.toLocaleString()}–{last.toLocaleString()}
                {total === null ? "" : ` of ${total.toLocaleString()}`}
              </span>
            ) : null}
            <Link
              to={`/network/activity?device=${encodeURIComponent(deviceId)}&source=${source}`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              View all activity
            </Link>
          </div>
          {page > 0 || data?.hasMore ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!data?.hasMore}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
