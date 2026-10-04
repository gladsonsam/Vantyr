/** Capture-associated observations. These are never atomic pixel attribution. */
export type RecallContextStatus = "observed" | "uncertain" | "unknown" | "not_collected";
export type RecallContextReason = "module_disabled" | "revoked" | "unsupported" | "no_foreground" | "not_browser" | "read_failed" | "sample_timeout" | "changed" | "identity_unverified" | "invalid_url" | "invalid_context";
export interface RecallWindowContext {
  status: RecallContextStatus; reason: RecallContextReason | null;
  source: "win32" | "hyprland" | "none"; app: string | null; title: string | null; title_truncated?: boolean;
}
export interface RecallBrowserContext {
  status: RecallContextStatus; reason: RecallContextReason | null;
  source: "uia_hwnd" | "none"; url: null; url_host: string | null;
}
export interface RecallCaptureContext {
  version: 1; scope: "session_foreground"; bracket_ms: number;
  monitor_relation: "unknown" | "same" | "other";
  window: RecallWindowContext; browser: RecallBrowserContext;
}
export interface RecallContextFilters {
  app: string | null; app_mode: "exact" | "prefix"; title: string | null;
  url_host: string | null; context: "all" | "known" | "unknown";
}
export const EMPTY_CONTEXT_FILTERS: RecallContextFilters = Object.freeze({app:null,app_mode:"exact",title:null,url_host:null,context:"all"});
const reasons: RecallContextReason[] = ["module_disabled","revoked","unsupported","no_foreground","not_browser","read_failed","sample_timeout","changed","identity_unverified","invalid_url","invalid_context"];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const bytes = (text: string) => new TextEncoder().encode(text).length;
const hasControls = (text:string) => [...text].some(char=>{const code=char.charCodeAt(0);return code<=31 || code>=127&&code<=159;});
export const asciiLower = (text: string) => text.replace(/[A-Z]/g, letter => letter.toLowerCase());
function bounded(value: unknown, max: number): value is string | null {
  return value === null || typeof value === "string" && bytes(value) <= max && !hasControls(value);
}
/** Host literals only: exact IDNA/domain/IP identity, never schemes, paths or ports. */
export function normalizeRecallHost(raw: string): string {
  const value = raw.trim();
  if (!value || bytes(value) > 253 || hasControls(value) || /[/@?#\\%\s]/u.test(value)) throw new Error("Enter an exact host without a scheme, path or port.");
  if (value.includes(":")) {
    const literal = value.startsWith("[") && value.endsWith("]") ? value : `[${value}]`;
    try { const url = new URL(`https://${literal}/`); if (url.port) throw new Error(); return url.hostname.slice(1,-1).toLowerCase(); }
    catch { throw new Error("Enter a valid IPv6 host without a port."); }
  }
  if (value.includes("[") || value.includes("]")) throw new Error("Enter a valid exact host.");
  try {
    const url = new URL(`https://${value.replace(/\.$/, "")}/`);
    const host = url.hostname.toLowerCase();
    if (!host || bytes(host) > 253 || host.split(".").some(part=>!part || part.length>63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) throw new Error();
    return host;
  } catch { throw new Error("Enter a valid exact host."); }
}
/** Reject invalid filters rather than silently broadening a restored search. */
export function parseRecallFilters(raw: unknown): RecallContextFilters {
  if (raw === undefined || raw === null) return {...EMPTY_CONTEXT_FILTERS};
  if (!object(raw)) throw new Error("Invalid capture context filters.");
  if (Object.keys(raw).some(key=>!["app","app_mode","title","url_host","context"].includes(key))) throw new Error("Invalid capture context filter field.");
  const text = (key: string, max: number) => {
    const value = raw[key];
    if (value === undefined || value === null) return null;
    if (!bounded(value,max)) throw new Error(`${key === "app" ? "App" : key === "title" ? "Title" : "Host"} filter exceeds its UTF-8 limit or contains control characters.`);
    return value.trim() || null;
  };
  const app = text("app",256), title = text("title",1024), host = text("url_host",253);
  const mode = raw.app_mode ?? "exact", context = raw.context ?? "all";
  if (mode !== "exact" && mode !== "prefix" || typeof context !== "string" || !["all","known","unknown"].includes(context)) throw new Error("Invalid capture context filter mode.");
  if (!app && mode !== "exact") throw new Error("Choose an app before using prefix matching.");
  if (context === "unknown" && (app || title || host)) throw new Error("Unknown context cannot be combined with app, title or host filters. Clear those fields first.");
  return {app:app ? asciiLower(app) : null,app_mode:mode,title,url_host:host ? normalizeRecallHost(host) : null,context:context as RecallContextFilters["context"]};
}
export function contextFiltersActive(filters: RecallContextFilters): boolean {
  return Boolean(filters.app || filters.title || filters.url_host || filters.context !== "all");
}
const unknownWindow = (): RecallWindowContext => ({status:"unknown",reason:"invalid_context",source:"none",app:null,title:null});
const unknownBrowser = (): RecallBrowserContext => ({status:"unknown",reason:"invalid_context",source:"none",url:null,url_host:null});
/** API parser discards ingestion-only revisions and invalid component values. */
export function parseRecallContext(raw: unknown): RecallCaptureContext | null {
  try {
    if (!object(raw) || bytes(JSON.stringify(raw)) > 4096 || raw.version !== 1 || raw.scope !== "session_foreground"
      || !Number.isInteger(raw.bracket_ms) || Number(raw.bracket_ms)<0 || Number(raw.bracket_ms)>1000
      || typeof raw.monitor_relation !== "string" || !["unknown","same","other"].includes(raw.monitor_relation)) return null;
    const component = (value: unknown, browser: boolean): boolean => object(value)
      && typeof value.status === "string" && ["observed","uncertain","unknown","not_collected"].includes(value.status)
      && (value.reason === null || reasons.includes(value.reason as RecallContextReason))
      && typeof value.source === "string" && (browser ? ["uia_hwnd","none"] : ["win32","hyprland","none"]).includes(value.source)
      && (value.status !== "observed" || value.source !== "none" && value.reason === null);
    let window = unknownWindow(), browser = unknownBrowser();
    const w = raw.window;
    if (component(w,false) && object(w) && bounded(w.app ?? null,256) && bounded(w.title ?? null,1024)
      && (w.title_truncated === undefined || typeof w.title_truncated === "boolean")
      && (w.status === "observed" || w.app == null && w.title == null)) {
      window = {status:w.status as RecallContextStatus,reason:w.reason as RecallContextReason|null,source:w.source as RecallWindowContext["source"],app:typeof w.app === "string" && w.app ? w.app : null,title:typeof w.title === "string" && w.title ? w.title : null,...(w.title_truncated === undefined ? {} : {title_truncated:w.title_truncated as boolean})};
    }
    const b = raw.browser;
    if (component(b,true) && object(b) && b.url == null && bounded(b.url_host ?? null,253) && (b.status === "observed" || b.url_host == null)) {
      try { browser = {status:b.status as RecallContextStatus,reason:b.reason as RecallContextReason|null,source:b.source as RecallBrowserContext["source"],url:null,url_host:typeof b.url_host === "string" && b.url_host ? normalizeRecallHost(b.url_host) : null}; } catch { /* unusable host remains unknown */ }
    }
    return {version:1,scope:"session_foreground",bracket_ms:Number(raw.bracket_ms),monitor_relation:raw.monitor_relation as RecallCaptureContext["monitor_relation"],window,browser};
  } catch { return null; }
}
/** Grouping excludes timing noise but never hides distinct context or uncertainty. */
export function recallContextSignature(raw: unknown): string {
  const context = parseRecallContext(raw);
  return context ? JSON.stringify([context.monitor_relation,context.window,context.browser]) : "legacy";
}
export function recallContextKnown(raw: unknown): boolean {
  const c = parseRecallContext(raw);
  return Boolean(c && (c.window.status === "observed" && (c.window.app || c.window.title) || c.browser.status === "observed" && c.browser.url_host));
}
