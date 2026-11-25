import type { RetentionPolicy } from "@/api/types";
import { daysToField, parseRetentionField } from "@/features/agent-settings/retentionForm";

export const MAX_RETENTION_DAYS = 36500;

export type RetentionKey = keyof RetentionPolicy;
export type RetentionFields = Record<RetentionKey, string>;

/** The three kinds of raw data the server prunes, labelled like the tools that show them. */
export const RETENTION_KINDS: readonly { key: RetentionKey; label: string }[] = [
  { key: "keylog_days", label: "Keystrokes" },
  { key: "window_days", label: "App windows and activity" },
  { key: "url_days", label: "Websites" },
];

/** Typed text that means the server's value (null / missing = keep forever, shown as 0). */
export function toRetentionFields(policy: { keylog_days?: number | null; window_days?: number | null; url_days?: number | null }): RetentionFields {
  return {
    keylog_days: daysToField(policy.keylog_days, "global"),
    window_days: daysToField(policy.window_days, "global"),
    url_days: daysToField(policy.url_days, "global"),
  };
}

export interface ParsedRetention {
  /** `null` while the text is not a usable value, or when it means "keep forever" (blank or 0). */
  days: number | null;
  error: string | null;
}

/** What one box means: blank or 0 keep forever (`days` null), 1 to 36500 is a limit, anything else is an error. */
export function parseRetentionText(text: string): ParsedRetention {
  const parsed = parseRetentionField(text, "global");
  return { days: parsed.value, error: parsed.error };
}

export function parseRetentionFields(fields: RetentionFields): Record<RetentionKey, ParsedRetention> {
  return {
    keylog_days: parseRetentionText(fields.keylog_days),
    window_days: parseRetentionText(fields.window_days),
    url_days: parseRetentionText(fields.url_days),
  };
}

/** The request body: 0 and blank are sent as null, meaning no automatic deletion. */
export function retentionBody(parsed: Record<RetentionKey, ParsedRetention>): RetentionPolicy {
  return { keylog_days: parsed.keylog_days.days, window_days: parsed.window_days.days, url_days: parsed.url_days.days };
}

export function fmtDays(days: number | null | undefined): string {
  if (days == null) return "forever";
  return days === 1 ? "1 day" : `${days} days`;
}

/** One line saying what the typed value will do, next to what is saved while they differ. */
export function describeRetention(parsed: ParsedRetention, savedDays: number | null | undefined): string {
  if (parsed.error) return "";
  const what = parsed.days === null ? "Keeps this data forever." : `Deletes data older than ${fmtDays(parsed.days)}.`;
  const saved = savedDays ?? null;
  return saved === parsed.days ? what : `${what} Saved: ${fmtDays(saved)}.`;
}

/** True when `next` keeps data for a shorter time than `saved` (forever is the longest). */
export function shortensRetention(saved: number | null | undefined, next: number | null): boolean {
  if (next === null) return false;
  return saved == null || next < saved;
}
