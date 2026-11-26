import { useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent } from "@vantyr/ui/components/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@vantyr/ui/components/input-group";
import { ToggleGroup, ToggleGroupItem } from "@vantyr/ui/components/toggle-group";
import { UnavailableSection } from "@/features/network/components/AvailabilityGate";
import { useEventsQuery } from "@/features/network/runtime/useRuntimeQueries";
import type { Effect } from "@/features/network/runtime/types";
import { fmtDateTime } from "@/lib/utils";
import { cn } from "@/lib/utils";

const PAGE = 20;
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
  const more = query.data?.state === "ready" ? query.data.data.nextCursor !== null : false;

  return (
    <Card className="gap-0 py-0">
      <CardContent className="space-y-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h3 className="font-medium">Query log</h3>
          <div className="flex flex-wrap items-center gap-3">
            <ToggleGroup
              value={[result]}
              onValueChange={(next) => {
                if (next[0]) {
                  setResult(next[0] as ResultFilter);
                  setLimit(PAGE);
                }
              }}
            >
              <ToggleGroupItem value="all">All</ToggleGroupItem>
              <ToggleGroupItem value="allow">Allowed</ToggleGroupItem>
              <ToggleGroupItem value="deny">Blocked</ToggleGroupItem>
            </ToggleGroup>
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
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2 pr-4 font-normal">Time</th>
                  <th className="py-2 pr-4 font-normal">Domain</th>
                  <th className="py-2 pr-4 font-normal">Result</th>
                  <th className="py-2 font-normal">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {events.map((event) => (
                  <tr key={event.id}>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-muted-foreground">
                      {fmtDateTime(event.at)}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-[0.8125rem]">{event.subject}</td>
                    <td
                      className={cn(
                        "py-2.5 pr-4 font-medium",
                        event.effect === "deny" ? "text-destructive" : "text-success",
                      )}
                    >
                      {event.effect === "deny" ? "Blocked" : "Allowed"}
                    </td>
                    <td className="py-2.5 text-muted-foreground">
                      {event.reason} · r{event.revision}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            A DNS decision is about a domain name. It is not a record of the pages someone visited.
          </p>
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
      </CardContent>
    </Card>
  );
}
