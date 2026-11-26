import { Card, CardContent } from "@vantyr/ui/components/card";
import AnimatedList from "@/components/react-bits/AnimatedList";
import { UnavailableSection } from "@/features/network/components/AvailabilityGate";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { useEventsQuery } from "@/features/network/runtime/useRuntimeQueries";
import type { EventSource } from "@/features/network/runtime/types";
import { cn } from "@/lib/utils";

const SOURCE_LABEL: Record<EventSource, string> = { dns: "DNS", proxy: "Proxy", agent: "Agent" };

/** Recent decisions for one device, optionally only from one connection. */
export function DeviceDecisions({
  deviceId,
  source,
  limit = 8,
  title = "Recent decisions",
}: {
  deviceId: string;
  source?: EventSource;
  limit?: number;
  title?: string;
}) {
  const query = useEventsQuery({ deviceId, source, limit });
  if (query.isPending) return null;
  if (query.isError) {
    return <UnavailableSection title={title} reason="Couldn’t load recent decisions." />;
  }
  if (query.data.state === "unavailable") {
    return <UnavailableSection title={title} reason={query.data.reason} />;
  }
  const { events } = query.data.data;
  return (
    <Card className="gap-0 py-0">
      <CardContent className="space-y-1 p-5">
        <h3 className="font-medium">{title}</h3>
        {events.length === 0 ? (
          <p className="pt-2 text-sm text-muted-foreground">
            Nothing recorded for this device yet.
          </p>
        ) : (
          <AnimatedList
            items={events.map((event) => ({ id: event.id, title: event.subject }))}
            frame={false}
            showGradients={false}
            displayScrollbar={false}
            enableArrowNavigation
            selectOnHover={false}
            accentColor="var(--primary)"
            width="100%"
            maxHeight={420}
            gap={0}
            renderItem={(_, index) => {
              const event = events[index];
              return (
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-border px-1 py-3 text-sm">
                  <span className="flex items-baseline gap-3">
                    <span
                      className={cn(
                        "w-14 font-medium",
                        event.effect === "deny" ? "text-destructive" : "text-success",
                      )}
                    >
                      {event.effect === "deny" ? "Blocked" : "Allowed"}
                    </span>
                    <span className="font-mono text-[0.8125rem]">{event.subject}</span>
                  </span>
                  <span className="text-muted-foreground">
                    {source ? null : `${SOURCE_LABEL[event.source]} · `}
                    {event.reason} · <TimeAgo iso={event.at} />
                  </span>
                </div>
              );
            }}
          />
        )}
        <p className="pt-3 text-xs text-muted-foreground">
          A DNS decision is about a domain name. It is not a record of the pages someone visited.
        </p>
      </CardContent>
    </Card>
  );
}
