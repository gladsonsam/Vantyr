import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { HelpTip } from "@/components/common/HelpTip";
import { KeyValueCard, KeyValueGrid } from "@/components/common/resource-detail/KeyValueCard";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import type { NetworkEvent } from "@/features/network/runtime/types";
import { cn, fmtDateTimePrecise } from "@/lib/utils";
import { EvidenceLabel } from "./EvidenceLabel";
import { eventDevice, eventPerson } from "./evidenceLib";

const SOURCE_LABEL = { dns: "DNS", proxy: "Proxy", agent: "Agent" } as const;

/** One observed domain or host: dot, host, who and how well known, why, and its detail on demand. */
export function ActivityRow({ event, grouped }: { event: NetworkEvent; grouped: boolean }) {
  const detailId = useId();
  const [open, setOpen] = useState(false);
  const person = eventPerson(event);
  const device = eventDevice(event);
  const blocked = event.effect === "deny";
  const seen =
    grouped || event.observations > 1
      ? `seen ${event.observations.toLocaleString()} ${event.observations === 1 ? "time" : "times"}`
      : null;
  return (
    <li className="relative flex flex-col gap-1 border-b border-border/60 py-3 pr-4 pl-10 last:border-b-0">
      <span
        aria-hidden
        className={cn(
          "absolute top-[1.15rem] left-4 size-2 rounded-full",
          blocked ? "bg-destructive" : "bg-primary",
        )}
      />
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        aria-label={`${blocked ? "Blocked" : "Allowed"} ${event.subject}`}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-baseline justify-between gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span
          className={cn(
            "min-w-0 truncate font-mono text-[0.8125rem]",
            blocked ? "text-destructive" : "font-medium",
          )}
        >
          {event.subject}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
          <TimeAgo iso={event.at} />
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3.5 transition-transform motion-reduce:transition-none",
              open && "rotate-180",
            )}
          />
        </span>
      </button>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span>{device.label}</span>
        <span aria-hidden="true">·</span>
        <span>{person.name ?? person.fallback}</span>
        {person.name ? <EvidenceLabel evidence={person.evidence} /> : null}
      </p>
      <p className="text-xs text-muted-foreground">
        {event.reason}
        {event.revision === null ? null : ` · r${event.revision}`}
        {seen ? ` · ${seen}` : null}
        {grouped && event.firstSeenAt && event.lastSeenAt ? (
          <>
            {" · first "}
            <TimeAgo iso={event.firstSeenAt} />
            {" · last "}
            <TimeAgo iso={event.lastSeenAt} />
          </>
        ) : null}
      </p>
      {open ? (
        <div id={detailId} className="mt-2">
          <KeyValueGrid className="sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3">
            <KeyValueCard label={grouped ? "Last seen" : "When"} format="text">
              {fmtDateTimePrecise(event.at)}
            </KeyValueCard>
            <KeyValueCard label="Decision" format="text">
              {blocked ? "Blocked" : "Allowed"}
            </KeyValueCard>
            <KeyValueCard label="Source" format="text">
              {SOURCE_LABEL[event.source]}
            </KeyValueCard>
            <KeyValueCard label="Matched rule or reason" format="text">
              {event.reason}
            </KeyValueCard>
            {event.revision === null ? null : (
              <KeyValueCard label="Policy revision" format="text">
                r{event.revision}
              </KeyValueCard>
            )}
            <KeyValueCard label="Identity evidence" format="text">
              {person.evidenceText}
            </KeyValueCard>
            <KeyValueCard label="Times seen" format="text">
              {event.observations.toLocaleString()}
            </KeyValueCard>
            {grouped && event.firstSeenAt ? (
              <KeyValueCard label="First seen" format="text">
                {fmtDateTimePrecise(event.firstSeenAt)}
              </KeyValueCard>
            ) : null}
            {event.correlationId === null ? null : (
              <KeyValueCard label="Correlation" format="code">
                {event.correlationId}
              </KeyValueCard>
            )}
            {event.dns ? (
              <>
                <KeyValueCard label="Query type" format="text">
                  {event.dns.queryType}
                </KeyValueCard>
                <KeyValueCard label="Protocol" format="text">
                  {event.dns.protocol}
                </KeyValueCard>
                {event.dns.appliedRule ? (
                  <KeyValueCard label="Matched rule" format="code">
                    {event.dns.appliedRule}
                  </KeyValueCard>
                ) : null}
                {event.dns.filterBlocked ? (
                  <KeyValueCard label="Blocked by list" format="text">
                    {[event.dns.filterSourceId, event.dns.filterSourceKind]
                      .filter((part): part is string => Boolean(part))
                      .join(" · ") || "Yes"}
                  </KeyValueCard>
                ) : null}
                {event.dns.deniedAliasTarget ? (
                  <KeyValueCard label="Alias target" format="code">
                    {event.dns.deniedAliasTarget}
                  </KeyValueCard>
                ) : null}
                <KeyValueCard label="Received" format="text">
                  {fmtDateTimePrecise(event.dns.receivedAt)}
                </KeyValueCard>
              </>
            ) : null}
          </KeyValueGrid>
          <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
            An observation, not a visit
            <HelpTip label="About this observation">
              An observation is a domain a gateway reported, not a page visit. A missing event means
              no observations were received, never that the device was protected. Allowed is a
              policy decision, even if the upstream lookup failed (for example SERVFAIL); it is not
              proof the answer succeeded or that anything was enforced.
            </HelpTip>
          </p>
        </div>
      ) : null}
    </li>
  );
}
