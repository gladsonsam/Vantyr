import type {
  EventSource,
  EventsCapabilities,
  EventsGrouping,
  IdentityEvidence,
  NetworkEvent,
} from "@/features/network/runtime/types";

export const EVIDENCE: Record<IdentityEvidence, { label: string; dot: string; text: string }> = {
  verified: { label: "Verified sign-in", dot: "bg-success", text: "text-success" },
  asserted: { label: "Asserted", dot: "bg-info", text: "text-info" },
  weak: { label: "Weak", dot: "bg-warning", text: "text-warning" },
  unknown: { label: "Unknown", dot: "bg-muted-foreground/50", text: "text-muted-foreground" },
  observed: {
    label: "Observed by DNS",
    dot: "bg-muted-foreground/50",
    text: "text-muted-foreground",
  },
};

export function evidenceLabel(evidence: IdentityEvidence): string {
  return EVIDENCE[evidence].label;
}

export const DNS_PERSON_UNKNOWN = "Person unknown (DNS identifies a device)";

export interface EventPerson {
  /** The person to name, or `null` when none may be claimed. */
  name: string | null;
  /** What to show when `name` is null. */
  fallback: string;
  /** The evidence to display, never stronger than the source can support. */
  evidence: IdentityEvidence;
  /** One line for detail views. */
  evidenceText: string;
}

/**
 * The only place that decides how an event's person is shown. A DNS observation identifies a device,
 * not a person: it never displays a verified sign-in, even if the data says so, because only a proxy
 * sign-in can verify who is using a device. DNS events that carry weaker evidence keep it as given.
 */
export function eventPerson(
  event: Pick<NetworkEvent, "source" | "personLabel" | "evidence">,
): EventPerson {
  const clamped =
    event.source === "dns" && (event.evidence === "verified" || event.evidence === "unknown");
  if (clamped) {
    return {
      name: null,
      fallback: DNS_PERSON_UNKNOWN,
      evidence: "unknown",
      evidenceText: "Unknown. DNS identifies a device, not a person",
    };
  }
  return {
    // A DNS observation names a device only, so its person is never claimed.
    name: event.source === "dns" && event.evidence === "observed" ? null : event.personLabel,
    fallback: event.source === "dns" ? DNS_PERSON_UNKNOWN : "No person identified",
    evidence: event.evidence,
    evidenceText: evidenceLabel(event.evidence),
  };
}

export const UNRECOGNISED_DEVICE = "Unrecognised device";

/** How an event's device is named. A null device id never links to a device page. */
export function eventDevice(
  event: Pick<NetworkEvent, "deviceId" | "deviceLabel" | "clientAddress">,
): {
  label: string;
  linkable: boolean;
} {
  if (event.deviceId === null) {
    return {
      label: event.clientAddress
        ? `${UNRECOGNISED_DEVICE} (${event.clientAddress})`
        : UNRECOGNISED_DEVICE,
      linkable: false,
    };
  }
  return { label: event.deviceLabel, linkable: true };
}

// ── What the event store can answer ─────────────────────────────────────────

export const NOT_AVAILABLE_YET = "Not available on this server yet";

const SOURCE_NAME: Record<EventSource, string> = { dns: "DNS", proxy: "Proxy", agent: "Agent" };

export function sourceSupported(
  capabilities: EventsCapabilities,
  source: EventSource | "all" | undefined,
): boolean {
  return !source || source === "all" || capabilities.sources.includes(source);
}

export function groupingSupported(
  capabilities: EventsCapabilities,
  grouping: EventsGrouping | undefined,
): boolean {
  return !grouping || capabilities.grouping.includes(grouping);
}

/** Shown instead of a list when the chosen source is unsupported: unsupported is not "no activity". */
export function unsupportedSourceText(source: EventSource): string {
  return `${SOURCE_NAME[source]} history isn’t available yet`;
}

export const UNLABELLED_DEVICE = "Unlabelled device";

/** Server errors a "Load more" can hit once the first page's window has aged out (HTTP 400). */
export const WINDOW_TOO_OLD = "The time window is too old to continue. Refresh the list.";
