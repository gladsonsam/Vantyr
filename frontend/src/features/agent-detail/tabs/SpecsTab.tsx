import { useState, useEffect, useRef, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/api";
import type { AgentInfo } from "@/api/types";
import { copyToClipboard } from "@/lib/utils";
import { ResourceHistory } from "@/features/agent-detail/components/ResourceHistory";

function isIpv4Address(ip: string): boolean {
  const t = ip.trim();
  if (!t || t.includes(":")) return false;
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(t);
}

/** Split addresses into IPv4 and IPv6 lists (original order preserved in each). */
function partitionIpAddresses(ips: string[]): { v4: string[]; v6: string[] } {
  const v4: string[] = [];
  const v6: string[] = [];
  for (const ip of ips) {
    (isIpv4Address(ip) ? v4 : v6).push(ip);
  }
  return { v4, v6 };
}

function formatCapabilityLabel(key: string): string {
  return key
    .split("_")
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function Meter({ label, value, info }: { label: string; value: number; info?: ReactNode }) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-sm font-semibold">{label}</div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      {info && <div className="text-xs text-muted-foreground">{info}</div>}
    </div>
  );
}

function Kv({ items }: { items: Array<{ label: ReactNode; value: ReactNode }> }) {
  return (
    <dl className="grid grid-cols-1 gap-4">
      {items.map((item, i) => (
        <div key={i}>
          <dt className="mb-1 text-xs font-medium text-muted-foreground">{item.label}</dt>
          <dd className="font-mono text-[13px] text-foreground">{item.value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="group rounded-xl bg-muted/50 px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown size={16} className="shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="pt-3">{children}</div>
    </details>
  );
}

function CopyableAddressList({ ips }: { ips: string[] }) {
  return (
    <span className="flex flex-col gap-1">
      {ips.map((ip, idx) => (
        <CopyableInline key={`${ip}-${idx}`} text={ip.trim()} />
      ))}
    </span>
  );
}

function CopyableInline({ text }: { text: string }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const flashClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (flashClearRef.current) clearTimeout(flashClearRef.current);
    };
  }, []);

  const onActivate = async () => {
    const ok = await copyToClipboard(text);
    if (!ok) return;
    const el = btnRef.current;
    if (!el) return;
    el.classList.remove("vantyr-copyable-inline--flash");
    // Reflow so the animation can run again on repeated clicks.
    void el.offsetWidth;
    el.classList.add("vantyr-copyable-inline--flash");
    if (flashClearRef.current) clearTimeout(flashClearRef.current);
    flashClearRef.current = setTimeout(() => {
      el.classList.remove("vantyr-copyable-inline--flash");
      flashClearRef.current = null;
    }, 600);
  };

  return (
    <button
      ref={btnRef}
      type="button"
      onClick={onActivate}
      title="Copy to clipboard"
      aria-label={`Copy ${text} to clipboard`}
      className="vantyr-copyable-inline"
    >
      {text}
    </button>
  );
}

interface SpecsTabProps {
  agentId: string;
  cachedInfo?: AgentInfo | null;
  agentOnline?: boolean;
}

export function SpecsTab({ agentId, cachedInfo, agentOnline = true }: SpecsTabProps) {
  const [info, setInfo] = useState<AgentInfo | null>(cachedInfo || null);
  const [loading, setLoading] = useState(!cachedInfo);
  const [error, setError] = useState<string | null>(null);
  const [receivedAtMs, setReceivedAtMs] = useState<number>(() => (cachedInfo ? Date.now() : 0));
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const [prevAgentId, setPrevAgentId] = useState(agentId);
  const [prevCachedInfo, setPrevCachedInfo] = useState(cachedInfo);

  if (agentId !== prevAgentId || cachedInfo !== prevCachedInfo) {
    setPrevAgentId(agentId);
    setPrevCachedInfo(cachedInfo);
    setError(null);
    setInfo(cachedInfo || null);
    setReceivedAtMs(cachedInfo ? Date.now() : 0);
    setLoading(!cachedInfo);
  }

  useEffect(() => {
    if (cachedInfo) return;

    const fetchInfo = async () => {
      try {
        setLoading(true);
        const { info: next } = await api.agentInfo(agentId);
        setInfo(next ?? null);
        setReceivedAtMs(Date.now());
      } catch (err) {
        setError("Couldn't load system info.");
        console.error(err);
      } finally {
        setLoading(false);
      }
    };

    fetchInfo();
  }, [agentId, cachedInfo]);

  useEffect(() => {
    if (!agentOnline) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [agentOnline]);

  // Resource history is independent telemetry (the `agent_metrics` time-series)
  // and must stay visible even when the system-info snapshot is loading, errored
  // or absent — otherwise it disappears for offline agents that still have
  // historical samples.
  if (loading || error || !info) {
    return (
      <div className="flex flex-col gap-6">
        <ResourceHistory agentId={agentId} />
        <Card>
          <CardContent className="flex items-center justify-center p-10">
            {loading ? (
              <Spinner className="size-8" aria-label="Loading system information" />
            ) : (
              <p className="text-sm text-destructive">
                {error || "No system info."}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const formatMemoryFromMb = (mb: number) => {
    const gb = (mb / 1024).toFixed(2);
    return `${gb} GB`;
  };
  const formatUptime = (secs?: number) => {
    if (!secs || secs < 0) return "—";
    const days = Math.floor(secs / 86400);
    const hours = Math.floor((secs % 86400) / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  };
  const liveUptimeSecs = (() => {
    if (!agentOnline) return info.uptime_secs;
    if (info.uptime_secs == null) return undefined;
    if (!receivedAtMs) return info.uptime_secs;
    const extra = Math.max(0, Math.floor((nowMs - receivedAtMs) / 1000));
    return info.uptime_secs + extra;
  })();

  const adapters = info.adapters ?? [];
  const loopbackPattern = /\b(loopback|pseudo-interface|localhost)\b/i;
  const [primaryAdapters, loopbackAdapters] = adapters.reduce(
    (acc, adapter) => {
      const name = adapter.name ?? "";
      const description = adapter.description ?? "";
      const ips = adapter.ips ?? [];
      const isLoopbackByText = loopbackPattern.test(name) || loopbackPattern.test(description);
      const isAllLocalIps =
        ips.length > 0 &&
        ips.every((ip) => {
          const v = ip.toLowerCase();
          return v === "127.0.0.1" || v === "::1";
        });

      if (isLoopbackByText || isAllLocalIps) {
        acc[1].push(adapter);
      } else {
        acc[0].push(adapter);
      }
      return acc;
    },
    [[], []] as [NonNullable<AgentInfo["adapters"]>, NonNullable<AgentInfo["adapters"]>]
  );

  const memoryPct =
    info.memory_total_mb && info.memory_total_mb > 0
      ? Math.min(100, Math.max(0, ((info.memory_used_mb || 0) / info.memory_total_mb) * 100))
      : undefined;

  const renderAdapter = (adapter: NonNullable<AgentInfo["adapters"]>[number], idx: number) => (
    <div key={`${adapter.name || "adapter"}-${idx}`}>
      <h3 className="mb-2 font-heading text-sm font-semibold">
        {adapter.name || `Adapter ${idx + 1}`}
      </h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Kv
          items={[
            {
              label: "MAC Address",
              value: adapter.mac?.trim() ? <CopyableInline text={adapter.mac.trim()} /> : "—",
            },
            {
              label: "IP Addresses",
              value: (() => {
                if (!adapter.ips?.length) return "—";
                // IPv4 first, then IPv6 — one evenly-spaced list so the gap
                // between the v4 and v6 groups matches the gap between rows.
                const { v4, v6 } = partitionIpAddresses(adapter.ips);
                return <CopyableAddressList ips={[...v4, ...v6]} />;
              })(),
            },
          ]}
        />
        <Kv
          items={[
            {
              label: "Gateway",
              value:
                adapter.gateways && adapter.gateways.length > 0
                  ? adapter.gateways.join(", ")
                  : "—",
            },
            {
              label: "DNS Servers",
              value:
                adapter.dns && adapter.dns.length > 0
                  ? adapter.dns.join(", ")
                  : "—",
            },
          ]}
        />
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <ResourceHistory agentId={agentId} />
      <Card>
        <CardHeader>
          <CardTitle>System</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Kv
              items={[
                { label: "Hostname", value: info.hostname || "—" },
                { label: "Agent version", value: info.agent_version || "—" },
                { label: "Logged-in user", value: info.current_user || "—" },
                { label: "System model", value: info.system_model || "—" },
                { label: "System manufacturer", value: info.system_manufacturer || "—" },
                { label: "OS", value: info.os_name || "—" },
                { label: "OS version", value: info.os_version || "—" },
              ]}
            />
            <Kv
              items={[
                { label: "CPU", value: info.cpu_brand || "—" },
                { label: "CPU cores", value: info.cpu_cores?.toString() || "—" },
                { label: "Uptime", value: formatUptime(liveUptimeSecs) },
                {
                  label: "Memory",
                  value: info.memory_total_mb
                    ? `${formatMemoryFromMb(info.memory_used_mb || 0)} / ${formatMemoryFromMb(info.memory_total_mb)}`
                    : "—",
                },
              ]}
            />
          </div>
          {(info.system_serial ||
            info.motherboard_model ||
            info.motherboard_manufacturer) && (
            <Section title="Hardware identifiers">
              <Kv
                items={[
                  { label: "System serial", value: info.system_serial || "—" },
                  { label: "Motherboard", value: info.motherboard_model || "—" },
                  { label: "Board maker", value: info.motherboard_manufacturer || "—" },
                ]}
              />
            </Section>
          )}
          {(info.config_path || info.install_path || info.config_server_url || info.config_agent_name) && (
            <Section title="Install & config">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Kv
                  items={[
                    { label: "Install path", value: info.install_path || "—" },
                    { label: "Config path", value: info.config_path || "—" },
                  ]}
                />
                <Kv
                  items={[
                    { label: "Server URL", value: info.config_server_url || "—" },
                    { label: "Configured name", value: info.config_agent_name || "—" },
                    {
                      label: "UI password set",
                      value: info.config_ui_password_set === true ? "Yes" : "No",
                    },
                  ]}
                />
              </div>
            </Section>
          )}
          {info.capabilities && (
            <Section title="Capabilities">
              <Kv
                items={Object.entries(info.capabilities)
                  .filter(([, value]) => value !== undefined && value !== null && `${value}`.trim() !== "")
                  .map(([key, value]) => ({
                    label: formatCapabilityLabel(key),
                    value: `${value}`,
                  }))}
              />
            </Section>
          )}
          {memoryPct !== undefined && (
            <Meter
              label="Memory usage"
              value={Math.round(memoryPct)}
              info={`${formatMemoryFromMb(info.memory_used_mb || 0)} used`}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Drives</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {info.drives && info.drives.length > 0 ? (
            info.drives.map((drive, idx) => {
              const total = drive.total_gb ?? 0;
              const available = drive.available_gb ?? 0;
              const used = Math.max(0, total - available);
              const pct = total > 0 ? Math.round((used / total) * 100) : 0;
              return (
                <div key={`${drive.mount_point || drive.name || "drive"}-${idx}`} className="flex flex-col gap-3">
                  <h3 className="font-heading text-sm font-semibold">
                    {drive.name || drive.mount_point || `Drive ${idx + 1}`}
                  </h3>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Kv
                      items={[
                        { label: "Mount", value: drive.mount_point || "—" },
                        { label: "File system", value: drive.file_system || "—" },
                      ]}
                    />
                    <Kv
                      items={[
                        { label: "Total", value: total > 0 ? `${total.toFixed(2)} GB` : "—" },
                        { label: "Available", value: `${available.toFixed(2)} GB` },
                      ]}
                    />
                  </div>
                  <Meter
                    label="Disk usage"
                    value={pct}
                    info={`${used.toFixed(2)} GB used`}
                  />
                </div>
              );
            })
          ) : (
            <p className="p-4 text-center text-sm text-muted-foreground">
              No drives
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Network adapters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {adapters.length > 0 ? (
            <>
              {primaryAdapters.length > 0 ? (
                <div className="flex flex-col gap-5">
                  {primaryAdapters.map((adapter, idx) => renderAdapter(adapter, idx))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No primary adapters.
                </p>
              )}
              {loopbackAdapters.length > 0 && (
                <Section title={`Loopback & local adapters (${loopbackAdapters.length})`}>
                  <div className="flex flex-col gap-5">
                    {loopbackAdapters.map((adapter, idx) =>
                      renderAdapter(adapter, primaryAdapters.length + idx)
                    )}
                  </div>
                </Section>
              )}
            </>
          ) : (
            <p className="p-4 text-center text-sm text-muted-foreground">
              No adapters
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
