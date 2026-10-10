import type { HistoryDay } from "@/api/types";

interface AgentCandidate {
  id: string;
  online: boolean;
  last_seen: string;
}

/**
 * Default agent for the Recall page when the URL names none.
 *
 * Per-agent recorded days are only available one request per agent, so the page
 * ranks on what the agent list already carries: online first, then most recently
 * seen. Every candidate already has history (the page filters on the devices list).
 */
export function pickDefaultAgentId(agents: readonly AgentCandidate[]): string | null {
  let best: AgentCandidate | null = null;
  for (const a of agents) {
    if (!best || Number(a.online) > Number(best.online) || (a.online === best.online && Date.parse(a.last_seen) > Date.parse(best.last_seen))) best = a;
  }
  return best?.id ?? null;
}

/** Recorded days (frames present, not in the future), oldest first. */
export function recordedDays(days: readonly HistoryDay[], today: string): HistoryDay[] {
  return days.filter((d) => d.frame_count > 0 && d.day <= today).sort((a, b) => a.day.localeCompare(b.day));
}

/** The most recent recorded day, or null when the agent has no coverage. */
export function latestRecordedDay(days: readonly HistoryDay[], today: string): HistoryDay | null {
  const covered = recordedDays(days, today);
  return covered[covered.length - 1] ?? null;
}

interface EmptyRangeInput {
  /** Null when the device's online state isn't known (embedded view). */
  online: boolean | null;
  /** Null while coverage is unavailable or failed. */
  days: readonly HistoryDay[] | null;
  day: string;
  today: string;
}

/** Explains an empty playback range from what the page knows; "unknown" is the last resort. */
export function describeEmptyRange({ online, days, day, today }: EmptyRangeInput): string {
  const covered = days ? recordedDays(days, today) : null;
  const offline = online === false ? " The device is offline." : "";
  if (covered && covered.length === 0) return `No recordings are retained for this device.${offline}`;
  if (covered) {
    const earliest = covered[0].day;
    const latest = covered[covered.length - 1].day;
    if (covered.some((d) => d.day === day)) return "No frames in this range or display. Try another display or the full day.";
    if (day < earliest) return `${day} is before the earliest retained recording (${earliest}); it has likely expired.`;
    if (day > latest) {
      return online === false
        ? `The device is offline; nothing has been recorded since ${latest}.`
        : `Nothing has been recorded since ${latest}.`;
    }
    return `Nothing was recorded on ${day}.${offline} Choose a recorded day.`;
  }
  return `No retained recording in this range.${offline} Choose another recorded day or display.`;
}
