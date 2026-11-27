import type {
  DnsManagementConfig,
  DnsManagementPatchBody,
  DnsOperation,
  DnsServiceCatalog,
  DnsSourcePatch,
  DnsSubscriptionSource,
} from "@/api/types";

/**
 * Pure client-side mirror of the server's DNS management validation
 * (server/src/network/dns_management_dto.rs). The server stays authoritative; this exists to give
 * field-level messages before a round trip. It never resolves or fetches a URL.
 */

export const DNS_LIMITS = {
  maxSources: 32,
  maxSourceIdLen: 64,
  maxUrlLen: 512,
  maxTextLen: 256,
  maxFieldLen: 200,
  maxDomainLen: 253,
  maxServices: 64,
  maxServiceDomains: 512,
  minIntervalSecs: 300,
  maxIntervalSecs: 604_800,
  minStaleSecs: 3_600,
  maxStaleSecs: 604_800,
  maxConfigBytes: 16 * 1024,
  maxRequestBytes: 32 * 1024,
  defaultIntervalSecs: 86_400,
  defaultMaxStaleSecs: 259_200,
} as const;

/** `path` is a dotted/indexed location, e.g. `operations[0].source.url` or `config.selected_services`. */
export interface DnsFieldError {
  path: string;
  message: string;
}

const ID_RE = /^[A-Za-z0-9_-]+$/;
const hasControl = (s: string) =>
  [...s].some((ch) => {
    const code = ch.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
const hasWhitespace = (s: string) => /\s/.test(s);
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** Returns a message, or null when valid. */
export function validateDnsId(raw: string, what = "id"): string | null {
  if (raw.length === 0 || raw.length > DNS_LIMITS.maxSourceIdLen || !ID_RE.test(raw)) {
    return `${what} must be 1 to 64 characters of letters, digits, "_" or "-"`;
  }
  return null;
}

export function validateDnsDomain(raw: string): string | null {
  if (
    raw.length === 0 ||
    raw.length > DNS_LIMITS.maxDomainLen ||
    raw.startsWith(".") ||
    raw.endsWith(".") ||
    raw.includes("*") ||
    hasControl(raw) ||
    hasWhitespace(raw)
  ) {
    return "Enter a hostname without wildcards, spaces or leading/trailing dots (max 253 characters)";
  }
  for (const label of raw.split(".")) {
    if (
      label.length === 0 ||
      label.length > 63 ||
      !/^[A-Za-z0-9-]+$/.test(label) ||
      label.startsWith("-") ||
      label.endsWith("-")
    ) {
      return "Each part of the hostname must be 1 to 63 letters, digits or hyphens, not starting or ending with a hyphen";
    }
  }
  return null;
}

function isPublicIpv4(host: string): boolean {
  const o = host.split(".").map(Number);
  const [a, b, c] = o;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function isPublicIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return false;
  const first = h.split(":")[0] ?? "";
  const seg = first === "" ? 0 : parseInt(first, 16);
  if (Number.isNaN(seg)) return false;
  return !(
    (seg & 0xfe00) === 0xfc00 ||
    (seg & 0xffc0) === 0xfe80 ||
    (seg & 0xff00) === 0xff00 ||
    h.startsWith("2001:db8:")
  );
}

/** Syntax-only URL check mirroring the server (HTTPS, no userinfo/query/fragment, public host). */
export function validateDnsSourceUrl(raw: string): string | null {
  if (
    raw.length === 0 ||
    raw.length > DNS_LIMITS.maxUrlLen ||
    hasControl(raw) ||
    hasWhitespace(raw)
  ) {
    return "Enter a URL up to 512 characters with no spaces";
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "This is not a valid URL";
  }
  if (url.protocol !== "https:") return "Only https:// URLs are allowed";
  if (url.username !== "" || url.password !== "")
    return "A URL with a username or password is not allowed";
  if (raw.includes("?") || raw.includes("#"))
    return "The URL must not include a query string or fragment";
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[")) {
    if (!isPublicIpv6(host.slice(1, -1))) return "The host must be a public address";
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (!isPublicIpv4(host)) return "The host must be a public address";
  } else {
    const domainError = validateDnsDomain(host);
    if (domainError) return "The host is not a valid hostname";
  }
  if (host === "github.com") {
    return "github.com serves an HTML page; use a raw.githubusercontent.com file URL";
  }
  if (host === "raw.githubusercontent.com") {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 4)
      return "raw.githubusercontent.com URLs must look like /owner/repo/ref/path";
  }
  return null;
}

export function validateDnsInterval(value: number | null | undefined): string | null {
  if (value == null) return null;
  if (
    !Number.isInteger(value) ||
    value < DNS_LIMITS.minIntervalSecs ||
    value > DNS_LIMITS.maxIntervalSecs
  ) {
    return "Refresh interval must be between 300 seconds (5 minutes) and 604800 seconds (7 days)";
  }
  return null;
}

export function validateDnsMaxStale(value: number | null | undefined): string | null {
  if (value == null) return null;
  if (
    !Number.isInteger(value) ||
    value < DNS_LIMITS.minStaleSecs ||
    value > DNS_LIMITS.maxStaleSecs
  ) {
    return "Maximum stale time must be between 3600 seconds (1 hour) and 604800 seconds (7 days)";
  }
  return null;
}

function validateText(raw: string, what: string, max: number): string | null {
  if (raw.trim().length === 0) return `${what} is required`;
  if (raw.length > max) return `${what} must be at most ${max} characters`;
  if (hasControl(raw)) return `${what} must not contain control characters`;
  return null;
}

function validateOptionalText(raw: string | null | undefined, what: string): string | null {
  if (raw == null) return null;
  if (raw.length > DNS_LIMITS.maxFieldLen)
    return `${what} must be at most ${DNS_LIMITS.maxFieldLen} characters`;
  if (hasControl(raw)) return `${what} must not contain control characters`;
  return null;
}

type Push = (path: string, message: string | null) => void;

function collector(errors: DnsFieldError[]): Push {
  return (path, message) => {
    if (message) errors.push({ path, message });
  };
}

function checkMetadata(push: Push, path: string, m: DnsSubscriptionSource["metadata"]) {
  push(`${path}.title`, validateText(m.title, "Title", DNS_LIMITS.maxTextLen));
  push(`${path}.publisher`, validateText(m.publisher, "Publisher", DNS_LIMITS.maxTextLen));
  push(`${path}.license`, validateText(m.license, "License", DNS_LIMITS.maxTextLen));
}

/** Field-level validation of one subscription source. */
export function validateDnsSource(source: DnsSubscriptionSource, path = "source"): DnsFieldError[] {
  const errors: DnsFieldError[] = [];
  const push = collector(errors);
  push(`${path}.id`, validateDnsId(source.id, "List id"));
  push(`${path}.url`, validateDnsSourceUrl(source.url));
  push(`${path}.interval_secs`, validateDnsInterval(source.interval_secs));
  push(`${path}.max_stale_secs`, validateDnsMaxStale(source.max_stale_secs));
  checkMetadata(push, `${path}.metadata`, source.metadata);
  return errors;
}

/** Field-level validation of a service catalog (without selected-service cross checks). */
export function validateDnsCatalog(catalog: DnsServiceCatalog, path = "catalog"): DnsFieldError[] {
  const errors: DnsFieldError[] = [];
  const push = collector(errors);
  push(`${path}.version`, validateText(catalog.version, "Catalog version", DNS_LIMITS.maxFieldLen));
  if (catalog.services.length > DNS_LIMITS.maxServices) {
    push(`${path}.services`, `A catalog can have at most ${DNS_LIMITS.maxServices} services`);
  }
  const seen = new Set<string>();
  catalog.services.forEach((svc, i) => {
    const p = `${path}.services[${i}]`;
    push(`${p}.id`, validateDnsId(svc.id, "Service id"));
    push(`${p}.label`, validateText(svc.label, "Label", DNS_LIMITS.maxFieldLen));
    push(`${p}.version`, validateText(svc.version, "Version", DNS_LIMITS.maxFieldLen));
    push(`${p}.source`, validateOptionalText(svc.source, "Source"));
    push(`${p}.evidence`, validateOptionalText(svc.evidence, "Evidence"));
    push(`${p}.license`, validateOptionalText(svc.license, "License"));
    if (svc.domains.length === 0 || svc.domains.length > DNS_LIMITS.maxServiceDomains) {
      push(`${p}.domains`, `A service needs between 1 and ${DNS_LIMITS.maxServiceDomains} domains`);
    }
    svc.domains.forEach((d, j) => {
      if (d.type !== "exact" && d.type !== "suffix") {
        push(`${p}.domains[${j}].type`, "Domain type must be exact or suffix");
      }
      push(`${p}.domains[${j}].value`, validateDnsDomain(d.value));
    });
    if (seen.has(svc.id)) push(`${p}.id`, "Duplicate service id");
    seen.add(svc.id);
  });
  return errors;
}

/** Whole-config validation (the server's `validate_config`), including selected ids against the catalog. */
export function validateDnsConfig(config: DnsManagementConfig, path = "config"): DnsFieldError[] {
  const errors: DnsFieldError[] = [];
  const push = collector(errors);
  if (config.sources.length > DNS_LIMITS.maxSources) {
    push(`${path}.sources`, `At most ${DNS_LIMITS.maxSources} lists are allowed`);
  }
  const ids = new Set<string>();
  config.sources.forEach((s, i) => {
    errors.push(...validateDnsSource(s, `${path}.sources[${i}]`));
    if (ids.has(s.id)) push(`${path}.sources[${i}].id`, "Duplicate list id");
    ids.add(s.id);
  });
  errors.push(
    ...validateDnsSelectedServices(
      config.selected_services,
      config.catalog,
      `${path}.selected_services`,
    ),
  );
  if (config.catalog) errors.push(...validateDnsCatalog(config.catalog, `${path}.catalog`));
  return errors;
}

/** Selected service ids must be unique, well formed and exist in the catalog (no catalog = none allowed). */
export function validateDnsSelectedServices(
  ids: string[],
  catalog: DnsServiceCatalog | null | undefined,
  path = "ids",
): DnsFieldError[] {
  const errors: DnsFieldError[] = [];
  if (ids.length > DNS_LIMITS.maxServices) {
    errors.push({ path, message: `At most ${DNS_LIMITS.maxServices} services can be selected` });
  }
  if (!catalog) {
    if (ids.length > 0)
      errors.push({ path, message: "Selecting services requires a service catalog" });
    return errors;
  }
  const known = new Set(catalog.services.map((s) => s.id));
  const seen = new Set<string>();
  ids.forEach((id, i) => {
    const idError = validateDnsId(id, "Service id");
    if (idError) errors.push({ path: `${path}[${i}]`, message: idError });
    if (seen.has(id)) errors.push({ path: `${path}[${i}]`, message: "Duplicate selected service" });
    seen.add(id);
    if (!known.has(id))
      errors.push({ path: `${path}[${i}]`, message: "This service is not in the catalog" });
  });
  return errors;
}

const patchKeys = [
  "url",
  "format",
  "enabled",
  "interval_secs",
  "max_stale_secs",
  "metadata",
] as const;

/**
 * Applies operations to `base` in order, the way the server does (pure; never mutates `base`).
 * `errors` holds operation-level problems (unknown/duplicate list ids, and the final config's
 * validation); `config` is the result when it could be computed.
 */
export function applyDnsOperations(
  base: DnsManagementConfig | null | undefined,
  operations: DnsOperation[],
): { config: DnsManagementConfig; errors: DnsFieldError[] } {
  const errors: DnsFieldError[] = [];
  const config: DnsManagementConfig = structuredClone(
    base ?? { sources: [], catalog: null, selected_services: [] },
  );
  operations.forEach((op, i) => {
    const p = `operations[${i}]`;
    switch (op.op) {
      case "add_list":
        if (config.sources.some((s) => s.id === op.source.id)) {
          errors.push({ path: `${p}.source.id`, message: "A list with this id already exists" });
        } else {
          config.sources.push(structuredClone(op.source));
        }
        break;
      case "remove_list": {
        const idx = config.sources.findIndex((s) => s.id === op.id);
        if (idx < 0) errors.push({ path: `${p}.id`, message: "No list with this id" });
        else config.sources.splice(idx, 1);
        break;
      }
      case "set_list": {
        const target = config.sources.find((s) => s.id === op.id);
        if (!target) {
          errors.push({ path: `${p}.id`, message: "No list with this id" });
          break;
        }
        for (const key of patchKeys) {
          if (!(key in op.patch)) continue;
          const value = (op.patch as Record<string, unknown>)[key];
          if (value === undefined) continue;
          if (value === null && key !== "interval_secs" && key !== "max_stale_secs") {
            errors.push({ path: `${p}.patch.${key}`, message: "This field cannot be cleared" });
            continue;
          }
          (target as unknown as Record<string, unknown>)[key] = structuredClone(value);
        }
        break;
      }
      case "set_catalog":
        config.catalog = structuredClone(op.catalog);
        break;
      case "select_services":
        config.selected_services = [...op.ids];
        break;
    }
  });
  config.sources.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (config.catalog)
    config.catalog.services.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  config.selected_services = [...new Set(config.selected_services)].sort();
  return { config, errors };
}

function validatePatch(patch: DnsSourcePatch, path: string): DnsFieldError[] {
  const errors: DnsFieldError[] = [];
  const push = collector(errors);
  const keys = Object.keys(patch);
  const unknown = keys.filter((k) => !(patchKeys as readonly string[]).includes(k));
  if (unknown.length) push(path, `Unknown field: ${unknown.join(", ")}`);
  if (patch.url !== undefined) push(`${path}.url`, validateDnsSourceUrl(patch.url));
  if (patch.format !== undefined && patch.format !== "hosts" && patch.format !== "abp") {
    push(`${path}.format`, "Format must be hosts or abp");
  }
  push(`${path}.interval_secs`, validateDnsInterval(patch.interval_secs));
  push(`${path}.max_stale_secs`, validateDnsMaxStale(patch.max_stale_secs));
  if (patch.metadata) checkMetadata(push, `${path}.metadata`, patch.metadata);
  return errors;
}

/**
 * Validates an operation list against the current config (null = nothing saved yet): per-operation
 * field rules, the config after applying them (counts, duplicates, selected ids exist in the
 * catalog), the 16 KiB config estimate and the 32 KiB request cap. Empty result means valid.
 */
export function validateDnsOperations(
  operations: DnsOperation[],
  current?: DnsManagementConfig | null,
  expectedConfigVersion = current ? 1 : 0,
): DnsFieldError[] {
  const errors: DnsFieldError[] = [];
  if (operations.length === 0) {
    return [{ path: "operations", message: "Add at least one change" }];
  }
  operations.forEach((op, i) => {
    const p = `operations[${i}]`;
    switch (op.op) {
      case "add_list":
        errors.push(...validateDnsSource(op.source, `${p}.source`));
        break;
      case "remove_list": {
        const m = validateDnsId(op.id);
        if (m) errors.push({ path: `${p}.id`, message: m });
        break;
      }
      case "set_list": {
        const m = validateDnsId(op.id);
        if (m) errors.push({ path: `${p}.id`, message: m });
        errors.push(...validatePatch(op.patch, `${p}.patch`));
        break;
      }
      case "set_catalog":
        errors.push(...validateDnsCatalog(op.catalog, `${p}.catalog`));
        break;
      case "select_services":
        break; // checked against the resulting catalog below
    }
  });
  const applied = applyDnsOperations(current, operations);
  errors.push(...applied.errors);
  // Whole-config rules, skipping per-field repeats already reported on the operation inputs.
  const seen = new Set(errors.map((e) => `${e.path}|${e.message}`));
  const cfg: DnsFieldError[] = [];
  if (applied.config.sources.length > DNS_LIMITS.maxSources) {
    cfg.push({ path: "operations", message: `At most ${DNS_LIMITS.maxSources} lists are allowed` });
  }
  const selectOps = operations
    .map((op, i) => (op.op === "select_services" ? i : -1))
    .filter((i) => i >= 0);
  const lastSelect = selectOps[selectOps.length - 1];
  for (const e of validateDnsSelectedServices(
    applied.config.selected_services,
    applied.config.catalog,
    "selected_services",
  )) {
    cfg.push({
      path: lastSelect !== undefined ? `operations[${lastSelect}].ids` : e.path,
      message: e.message,
    });
  }
  for (const e of cfg) if (!seen.has(`${e.path}|${e.message}`)) errors.push(e);

  if (errors.length === 0) {
    const configBytes = bytes(
      JSON.stringify({
        sources: applied.config.sources.map((s) => ({
          ...s,
          interval_secs: s.interval_secs ?? null,
          max_stale_secs: s.max_stale_secs ?? null,
        })),
        catalog: applied.config.catalog,
        selected_services: applied.config.selected_services,
      }),
    );
    if (configBytes > DNS_LIMITS.maxConfigBytes) {
      errors.push({
        path: "operations",
        message: "The resulting configuration is larger than 16 KiB",
      });
    }
    const body: DnsManagementPatchBody = {
      expected_config_version: expectedConfigVersion,
      operations,
    };
    if (bytes(JSON.stringify(body)) > DNS_LIMITS.maxRequestBytes) {
      errors.push({ path: "operations", message: "The request is larger than 32 KiB" });
    }
  }
  return errors;
}
