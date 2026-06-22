import type { AgentInfo } from "./types";

// Adapters that are virtual / internal and should only supply the headline IP
// as a last resort (WSL, Hyper-V, Docker, VPNs, loopback, etc.). On a typical
// Windows host these expose 172.x / 192.168.x addresses that are NOT the
// machine's real LAN address, so they must not win over a physical NIC.
const VIRTUAL_ADAPTER_RE =
  /\b(virtual|vethernet|hyper-?v|vmware|virtualbox|vbox|docker|wsl|loopback|pseudo|bluetooth|tailscale|zerotier|tun|tap|wireguard|openvpn|npcap)\b/i;

function isLoopback(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  return v.startsWith("127.") || v === "::1";
}

/** APIPA (IPv4) + IPv6 link-local — present when there's no real network, not a LAN address. */
function isLinkLocal(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  return v.startsWith("169.254.") || v.startsWith("fe80:");
}

function isIpv4(ip: string): boolean {
  return ip.includes(".") && !ip.includes(":");
}

/**
 * Pick the IP address to show as an agent's headline address.
 *
 * Prefers a real IPv4 (non-loopback, non-link-local) on a physical adapter,
 * then relaxes in stages: any non-loopback IPv4, then any non-loopback address
 * (IPv6). Virtual/internal adapters are only consulted after physical ones.
 * Returns `null` when nothing usable is reported (callers supply a placeholder).
 */
export function primaryIp(info: AgentInfo | null | undefined): string | null {
  const adapters = info?.adapters ?? [];
  if (adapters.length === 0) return null;

  const physical = adapters.filter(
    (a) => !VIRTUAL_ADAPTER_RE.test(`${a.name ?? ""} ${a.description ?? ""}`),
  );
  const virtual = adapters.filter((a) => !physical.includes(a));
  const ordered = [...physical, ...virtual];

  const findIp = (pred: (ip: string) => boolean): string | null => {
    for (const adapter of ordered) {
      const ip = adapter.ips?.find((c) => c && pred(c));
      if (ip) return ip.trim();
    }
    return null;
  };

  return (
    findIp((ip) => isIpv4(ip) && !isLoopback(ip) && !isLinkLocal(ip)) ??
    findIp((ip) => isIpv4(ip) && !isLoopback(ip)) ??
    findIp((ip) => !isLoopback(ip) && !isLinkLocal(ip))
  );
}
