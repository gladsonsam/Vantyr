import type { CapabilityId } from "@/features/network/runtime/types";

export const CAPABILITY_LABEL: Record<CapabilityId, string> = {
  dns_filtering: "DNS filtering",
  local_records: "Local records",
  encrypted_dns: "Encrypted DNS",
  http_proxy: "HTTP and CONNECT proxy",
  https_inspection: "HTTPS inspection",
};

/** Traffic no gateway can see. Shown as plain limits, never as a guarantee. */
export const COVERAGE_LIMITS = [
  "Devices using encrypted DNS (DoH or DoT) to a resolver of their own skip Vantyr DNS.",
  "QUIC and other traffic that doesn’t go through the proxy isn’t filtered by it.",
  "A VPN, a mobile connection, or any network away from home bypasses both gateways.",
  "Apps that pin their certificates can’t be inspected, and fail if HTTPS inspection is on.",
  "On a shared device with nobody verified, only that device’s defaults apply.",
] as const;
