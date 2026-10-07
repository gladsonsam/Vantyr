import { z } from "zod";

export const MAX_TOKEN_USES = 100_000;
export const MAX_EXPIRY_HOURS = 24 * 365;

/** Pairing code options as typed: how many claims, an optional expiry in hours, an optional note. */
export const enrollmentTokenSchema = z.object({
  uses: z.number().min(1).max(MAX_TOKEN_USES),
  expire_hours: z.string(),
  note: z.string(),
});
export type EnrollmentTokenValues = z.infer<typeof enrollmentTokenSchema>;

export const DEFAULT_TOKEN_VALUES: EnrollmentTokenValues = { uses: 1, expire_hours: "", note: "" };

export interface EnrollmentTokenBody {
  uses: number;
  expires_in_hours?: number;
  note?: string;
}

/** What the "Uses" box turns typed text into: a whole-ish number between 1 and 100000. */
export function parseTokenUses(raw: string): number {
  return Math.max(1, Math.min(MAX_TOKEN_USES, Number(raw) || 1));
}

/** The request body for the typed options. An empty expiry means the server default. */
export function tokenValuesToBody(values: EnrollmentTokenValues): EnrollmentTokenBody {
  const body: EnrollmentTokenBody = { uses: Math.max(1, Math.min(MAX_TOKEN_USES, Number(values.uses) || 1)) };
  const rawHours = values.expire_hours.trim();
  if (rawHours !== "") {
    body.expires_in_hours = Math.max(1, Math.min(MAX_EXPIRY_HOURS, parseInt(rawHours, 10) || 0));
  }
  const note = values.note.trim();
  if (note) body.note = note;
  return body;
}
