import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class strings safely. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function normalizeTimestampInput(ts: string | number): string | number {
  if (typeof ts === "number") return ts;
  const trimmed = ts.trim();
  if (!trimmed) return trimmed;
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return trimmed.length > 10 ? Math.floor(numeric / 1000) : numeric;
    }
  }
  return trimmed;
}

export function parseTimestamp(ts: string | number | undefined): Date | null {
  if (ts === undefined || ts === null) return null;
  const normalized = normalizeTimestampInput(ts);
  const date =
    typeof normalized === "number" ? new Date(normalized * 1000) : new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Format an ISO string or unix-seconds timestamp to a short time string. */
export function fmtTime(ts: string | number | undefined): string {
  const d = parseTimestamp(ts);
  return d ? d.toLocaleTimeString() : "—";
}

/** Format an ISO string or unix-seconds timestamp to a full date-time string. */
export function fmtDateTime(ts: string | number | undefined): string {
  const d = parseTimestamp(ts);
  return d ? d.toLocaleString() : "—";
}

/**
 * Date/time with milliseconds so events that share the same clock second still read in true order.
 */
export function fmtDateTimePrecise(ts: string | number | undefined): string {
  const d = parseTimestamp(ts);
  if (!d) return "—";
  const opts: Intl.DateTimeFormatOptions & { fractionalSecondDigits?: 1 | 2 | 3 } = {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    fractionalSecondDigits: 3,
  };
  return d.toLocaleString(undefined, opts);
}

/**
 * Windows Uninstall `InstallDate` is often REG_SZ `YYYYMMDD` or `YYYYMMDDHHmmss`.
 * Show as `YYYY-MM-DD` for the Software tab (also normalizes rows already stored raw).
 */
export function formatWindowsInstallDate(s: string | null | undefined): string {
  if (s == null) return "—";
  const t = String(s).trim();
  if (!t) return "—";
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) {
    return t.slice(0, 10);
  }
  const digits = t.replace(/\D/g, "");
  const head =
    digits.length >= 14 ? digits.slice(0, 8) : digits.length === 8 ? digits : "";
  if (head.length === 8) {
    const y = Number(head.slice(0, 4));
    const m = Number(head.slice(4, 6));
    const d = Number(head.slice(6, 8));
    if (y >= 1980 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  return t;
}

/** Vantyr sort key for missing/invalid install dates (see `compareInstallDateSortKeys` for ordering). */
export const INSTALL_DATE_SORT_MISSING = "99999999";

/** Lexicographic sort key for `install_date` (unknown / invalid → `INSTALL_DATE_SORT_MISSING`). */
export function installDateSortKey(s: string | null | undefined): string {
  const missing = INSTALL_DATE_SORT_MISSING;
  if (s == null) return missing;
  const t = String(s).trim();
  if (!t) return missing;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) {
    return t.slice(0, 10).replace(/-/g, "");
  }
  const digits = t.replace(/\D/g, "");
  const head =
    digits.length >= 14 ? digits.slice(0, 8) : digits.length === 8 ? digits : "";
  if (head.length === 8) {
    const y = Number(head.slice(0, 4));
    const m = Number(head.slice(4, 6));
    const d = Number(head.slice(6, 8));
    if (y >= 1980 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return head;
    }
  }
  return missing;
}

/**
 * Sort by `installDateSortKey` values: rows without a date stay last in both directions.
 * `descending` true = newest (largest YYYYMMDD) first.
 */
export function compareInstallDateSortKeys(aKey: string, bKey: string, descending: boolean): number {
  const am = aKey === INSTALL_DATE_SORT_MISSING;
  const bm = bKey === INSTALL_DATE_SORT_MISSING;
  if (am && bm) return 0;
  if (am) return 1;
  if (bm) return -1;
  const c = aKey.localeCompare(bKey);
  return descending ? -c : c;
}

/** Truncate a string to `maxLen` characters, appending '…' if truncated. */
export function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
}

/** Copy text to clipboard and return true on success. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
