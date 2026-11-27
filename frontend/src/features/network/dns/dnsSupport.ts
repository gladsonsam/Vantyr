import type { DnsSupportedSettings, DnsView } from "@/features/network/runtime/types";

/** A server that sends no flags supports every setting (the demo). */
export function resolveSupported(view: Pick<DnsView, "supportedSettings">): DnsSupportedSettings {
  return {
    cache: true,
    serveExpired: true,
    ttlBounds: true,
    rateLimit: true,
    retention: true,
    responseMode: true,
    ...view.supportedSettings,
  };
}
