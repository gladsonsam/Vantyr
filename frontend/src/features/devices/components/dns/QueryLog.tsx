import { useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { HelpTip } from "@/components/common/HelpTip";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@vantyr/ui/components/input-group";
import RubberSegment from "@/components/react-bits/RubberSegment";
import { UnavailableSection } from "@/features/network/components/AvailabilityGate";
import { useEventsQuery } from "@/features/network/runtime/useRuntimeQueries";
import type { Effect } from "@/features/network/runtime/types";
import { fmtDateTime } from "@/lib/utils";
import { cn } from "@/lib/utils";

const PAGE = 8;
type ResultFilter = "all" | Effect;

/** Every DNS decision for this device, newest first, searchable and filterable. */
export function QueryLog({ deviceId }: { deviceId: string }) {
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<ResultFilter>("all");
  const [limit, setLimit] = useState(PAGE);
  const query = useEventsQuery({
    deviceId,
    source: "dns",
    search: search.trim() || undefined,
    effect: result === "all" ? undefined : result,
    limit,
  });

  const events = query.data?.state === "ready" ? query.data.data.events : [];
  const retention = query.data?.state === "ready" ? query.data.data : null;
  const more = query.data?.state === "ready" ? query.data.data.nextCursor !== null : false;

  return (
    <div className="space-y-5 rounded-xl border border-border/70 bg-card/10 p-5">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h3 className="flex items-center gap-1 font-medium">
            Recent queries
            <HelpTip label="About the query log">
              A DNS decision is about a domain name. It is not a record of the pages someone
              visited.
            </HelpTip>
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
                setLimit(PAGE);
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
                  setLimit(PAGE);
                }}
                placeholder="Search domains…"
                aria-label="Search the query log"
              />
            </InputGroup>
          </div>
        </div>

        {query.data?.state === "unavailable" ? (
          <UnavailableSection title="Query log" reason={query.data.reason} />
        ) : query.isError ? (
          <UnavailableSection title="Query log" reason="Couldn’t load the query log." />
        ) : events.length === 0 && !query.isPending ? (
          <p className="py-6 text-sm text-muted-foreground">No queries match.</p>
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

        <div className="flex flex-wrap items-center justify-between gap-3">
          {retention ? (
            <p className="text-xs text-muted-foreground">
              Keeping {retention.retention.days} days. {retention.usage.events.toLocaleString()} of{" "}
              {retention.retention.maxEvents.toLocaleString()} queries stored.
            </p>
          ) : (
            <span />
          )}
          {more ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLimit((current) => current + PAGE)}
            >
              Show more
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
