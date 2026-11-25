/** Presentation helpers shared by the Websites / Keystrokes / App windows / Rule events lists. */

export interface UrlParts {
  /** Registrable-looking host without a leading `www.` ("" when the value is not a URL). */
  host: string;
  /** Path + query + hash, "" for a bare domain. */
  rest: string;
  /** Full URL ready for `href` (https assumed when the scheme is missing). */
  href: string;
}

/** Splits a visited URL into the domain people scan for and the remainder that identifies the page. */
export function splitUrl(value: string | null | undefined): UrlParts {
  const raw = (value ?? "").trim();
  if (!raw) return { host: "", rest: "", href: "#" };
  const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(href);
    const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
    return { host: parsed.host.replace(/^www\./i, ""), rest, href };
  } catch {
    return { host: raw, rest: "", href };
  }
}

/** The server labels visits it could not classify "Uncategorized"; that is the absence of a category, not a value. */
export function categoryOf(category: string | null | undefined): string | undefined {
  const value = (category ?? "").trim();
  return value && value.toLowerCase() !== "uncategorized" ? value : undefined;
}

/**
 * "12 visits", "500 most recent visits" (the list is capped, so a total would be a lie) and, while a
 * search narrows it, "8 of 500 most recent visits".
 */
export function listCountLabel({ shown, loaded, limit, noun }: {
  shown: number;
  loaded: number;
  limit: number;
  noun: { one: string; many: string };
}): string {
  const capped = loaded >= limit;
  const word = loaded === 1 ? noun.one : noun.many;
  const base = capped ? `${loaded.toLocaleString()} most recent ${word}` : `${loaded.toLocaleString()} ${word}`;
  return shown === loaded ? base : `${shown.toLocaleString()} of ${base}`;
}

/** Does `title` only restate the application it belongs to ("Notepad" in Notepad)? */
export function titleRestatesApp(title: string | null | undefined, ...appNames: Array<string | null | undefined>): boolean {
  const value = (title ?? "").trim().toLowerCase();
  if (!value || value === "—") return true;
  return appNames.some((name) => {
    const app = (name ?? "").trim().toLowerCase();
    return app !== "" && (app === value || app.replace(/\.exe$/, "") === value);
  });
}

const LONG_TEXT_CHARS = 180;
const LONG_TEXT_LINES = 3;

/** Typed text worth folding behind "Show all" instead of letting it fill the page. */
export function isLongText(text: string): boolean {
  return text.length > LONG_TEXT_CHARS || text.split("\n").length > LONG_TEXT_LINES;
}

/** The one value every entry agrees on ("" when they differ or there are none). */
export function sharedValue(values: readonly string[]): string {
  if (values.length === 0) return "";
  const first = values[0];
  return values.every((v) => v === first) ? first : "";
}
