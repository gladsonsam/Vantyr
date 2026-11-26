import { Link } from "react-router-dom";
import { ListChecks } from "lucide-react";
import { HelpTip } from "@/components/common/HelpTip";
import { OverviewCard } from "./OverviewCard";
import { DetailSection } from "@/components/common/resource-detail/DetailSection";
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
  compact = false,
  viewAllTo,
  className,
}: {
  deviceId: string;
  source?: EventSource;
  limit?: number;
  title?: string;
  /** A short card of dot, domain and time; blocked rows are coloured. */
  compact?: boolean;
  /** Where "View all" goes, in compact mode. */
  viewAllTo?: string;
  className?: string;
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
  if (compact) {
    return (
      <OverviewCard
        title={title}
        help={
          <HelpTip label="About decisions">
            A DNS decision is about a domain name. It is not a record of the pages someone
            visited.
          </HelpTip>
        }
        action={
          viewAllTo ? (
            <Link
              to={viewAllTo}
              className="inline-flex h-8 items-center rounded-md px-2 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              View all
            </Link>
          ) : null
        }
        className={className}
      >
        {events.length === 0 ? (
          <p className="text-base text-muted-foreground">Nothing recorded for this device yet.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {events.map((event) => {
              const blocked = event.effect === "deny";
              return (
                <li
                  key={event.id}
                  aria-label={`${blocked ? "Blocked" : "Allowed"} ${event.subject}`}
                  className="flex items-center gap-3 py-3 text-base first:pt-0 last:pb-0"
                >
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      blocked ? "bg-destructive" : "bg-success",
                    )}
                    aria-hidden="true"
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate font-mono text-sm",
                      blocked && "text-destructive",
                    )}
                  >
                    {event.subject}
                  </span>
                  <span className="shrink-0 text-sm text-muted-foreground">
                    <TimeAgo iso={event.at} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </OverviewCard>
    );
  }
  return (
    <DetailSection title={title} icon={ListChecks}>
      <div className="rounded-xl border border-border/70 bg-card/10 p-5">
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
      </div>
    </DetailSection>
  );
}
