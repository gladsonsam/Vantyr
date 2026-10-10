import { z } from "zod";

export const MAX_RETENTION_DAYS = 36500;

const days = z.number().min(0).max(MAX_RETENTION_DAYS);

/** Days to keep each kind of raw data; 0 means keep everything. */
export const retentionSchema = z.object({
  keylog_days: days,
  window_days: days,
  url_days: days,
});
export type RetentionValues = z.infer<typeof retentionSchema>;

export const NO_RETENTION: RetentionValues = { keylog_days: 0, window_days: 0, url_days: 0 };

/** What a number box turns typed text into: a number of days between 0 and 36500. */
export function parseRetentionDays(raw: string): number {
  return Math.max(0, Math.min(MAX_RETENTION_DAYS, Number(raw) || 0));
}

/** The server's retention (null / missing = unlimited) as form values. */
export function toRetentionValues(r: { keylog_days?: number | null; window_days?: number | null; url_days?: number | null }): RetentionValues {
  return { keylog_days: r.keylog_days ?? 0, window_days: r.window_days ?? 0, url_days: r.url_days ?? 0 };
}

/** The request body: 0 days is sent as null, meaning no automatic prune. */
export function retentionToBody(values: RetentionValues): { keylog_days: number | null; window_days: number | null; url_days: number | null } {
  return {
    keylog_days: values.keylog_days === 0 ? null : values.keylog_days,
    window_days: values.window_days === 0 ? null : values.window_days,
    url_days: values.url_days === 0 ? null : values.url_days,
  };
}
