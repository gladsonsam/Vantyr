import { Container, Header, ColumnLayout, Box, SpaceBetween, Spinner, KeyValuePairs, ExpandableSection, ProgressBar } from "../ui/console";
import { useState, useEffect, useRef } from "react";
import { api } from "../../lib/api";
import type { AgentInfo } from "../../lib/types";
import { copyToClipboard } from "../../lib/utils";

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

function CopyableAddressList({ ips }: { ips: string[] }) {
  return (
    <SpaceBetween size="xxs" direction="vertical">
      {ips.map((ip, idx) => (
        <CopyableInline key={`${ip}-${idx}`} text={ip.trim()} />
      ))}
    </SpaceBetween>
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
        setError("Error fetching system information");
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

  if (loading) {
    return (
      <Container>
        <Box textAlign="center" padding="xxl">
          <Spinner size="large" />
        </Box>
      </Container>
    );
  }

  if (error || !info) {
    return (
      <Container>
        <Box textAlign="center" padding="xxl">
          <Box variant="p" color="text-status-error">
            {error || "No system information available"}
          </Box>
        </Box>
      </Container>
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
    <Box key={`${adapter.name || "adapter"}-${idx}`}>
      <Box variant="h3" margin={{ bottom: "s" }}>
        {adapter.name || `Adapter ${idx + 1}`}
      </Box>
      <ColumnLayout columns={2} variant="text-grid">
        <KeyValuePairs
          columns={1}
          items={[
            {
              label: "MAC Address",
              value: adapter.mac?.trim() ? <CopyableInline text={adapter.mac.trim()} /> : "—",
            },
            {
              label: "IP Addresses",
              value: (() => {
                if (!adapter.ips?.length) return "—";
                const { v4, v6 } = partitionIpAddresses(adapter.ips);
                return (
                  <Box variant="div">
                    {v4.length > 0 ? (
                      <Box variant="div" margin={{ bottom: v6.length > 0 ? "xs" : undefined }}>
                        <CopyableAddressList ips={v4} />
                      </Box>
                    ) : null}
                    {v6.length > 0 ? (
                      <Box variant="div">
                        <CopyableAddressList ips={v6} />
                      </Box>
                    ) : null}
                  </Box>
                );
              })(),
            },
          ]}
        />
        <KeyValuePairs
          columns={1}
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
      </ColumnLayout>
    </Box>
  );

  return (
    <SpaceBetween size="l">
      <Container header={<Header variant="h2">System Information</Header>}>
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValuePairs
            columns={1}
            items={[
              { label: "Hostname", value: info.hostname || "—" },
              { label: "Agent Version", value: info.agent_version || "—" },
              { label: "Logged-in user", value: info.current_user || "—" },
              { label: "System model", value: info.system_model || "—" },
              { label: "System manufacturer", value: info.system_manufacturer || "—" },
              { label: "Operating System", value: info.os_name || "—" },
              { label: "OS Version", value: info.os_version || "—" },
            ]}
          />
          <KeyValuePairs
            columns={1}
            items={[
              { label: "CPU", value: info.cpu_brand || "—" },
              { label: "CPU Cores", value: info.cpu_cores?.toString() || "—" },
              { label: "Uptime", value: formatUptime(liveUptimeSecs) },
              {
                label: "Memory",
                value: info.memory_total_mb
                  ? `${formatMemoryFromMb(info.memory_used_mb || 0)} / ${formatMemoryFromMb(info.memory_total_mb)}`
                  : "—",
              },
            ]}
          />
        </ColumnLayout>
        {(info.system_serial ||
          info.motherboard_model ||
          info.motherboard_manufacturer) && (
          <Box margin={{ top: "m" }}>
            <ExpandableSection headerText="Hardware identifiers">
              <ColumnLayout columns={2} variant="text-grid">
                <KeyValuePairs
                  columns={1}
                  items={[
                    { label: "System serial", value: info.system_serial || "—" },
                    { label: "Motherboard", value: info.motherboard_model || "—" },
                    { label: "Board maker", value: info.motherboard_manufacturer || "—" },
                  ]}
                />
              </ColumnLayout>
            </ExpandableSection>
          </Box>
        )}
        {(info.config_path || info.install_path || info.config_server_url || info.config_agent_name) && (
          <Box margin={{ top: "m" }}>
            <ExpandableSection headerText="Agent install & config">
              <ColumnLayout columns={2} variant="text-grid">
                <KeyValuePairs
                  columns={1}
                  items={[
                    { label: "Install path", value: info.install_path || "—" },
                    { label: "Config path", value: info.config_path || "—" },
                  ]}
                />
                <KeyValuePairs
                  columns={1}
                  items={[
                    { label: "Server URL", value: info.config_server_url || "—" },
                    { label: "Agent name (config)", value: info.config_agent_name || "—" },
                    {
                      label: "UI password set",
                      value: info.config_ui_password_set === true ? "Yes" : "No",
                    },
                  ]}
                />
              </ColumnLayout>
            </ExpandableSection>
          </Box>
        )}
        {memoryPct !== undefined && (
          <Box margin={{ top: "m" }}>
            <ProgressBar
              label="Memory usage"
              value={Math.round(memoryPct)}
              additionalInfo={`${formatMemoryFromMb(info.memory_used_mb || 0)} used`}
            />
          </Box>
        )}
      </Container>

      <Container header={<Header variant="h2">Drives</Header>}>
        {info.drives && info.drives.length > 0 ? (
          <SpaceBetween size="l">
            {info.drives.map((drive, idx) => {
              const total = drive.total_gb ?? 0;
              const available = drive.available_gb ?? 0;
              const used = Math.max(0, total - available);
              const pct = total > 0 ? Math.round((used / total) * 100) : 0;
              return (
                <Box key={`${drive.mount_point || drive.name || "drive"}-${idx}`}>
                  <Box variant="h3" margin={{ bottom: "s" }}>
                    {drive.name || drive.mount_point || `Drive ${idx + 1}`}
                  </Box>
                  <ColumnLayout columns={2} variant="text-grid">
                    <KeyValuePairs
                      columns={1}
                      items={[
                        { label: "Mount", value: drive.mount_point || "—" },
                        { label: "File system", value: drive.file_system || "—" },
                      ]}
                    />
                    <KeyValuePairs
                      columns={1}
                      items={[
                        { label: "Total", value: total > 0 ? `${total.toFixed(2)} GB` : "—" },
                        { label: "Available", value: `${available.toFixed(2)} GB` },
                      ]}
                    />
                  </ColumnLayout>
                  <Box margin={{ top: "s" }}>
                    <ProgressBar
                      label="Disk usage"
                      value={pct}
                      additionalInfo={`${used.toFixed(2)} GB used`}
                    />
                  </Box>
                </Box>
              );
            })}
          </SpaceBetween>
        ) : (
          <Box textAlign="center" padding="l">
            <Box variant="p" color="text-body-secondary">
              No drive info available
            </Box>
          </Box>
        )}
      </Container>

      <Container header={<Header variant="h2">Network Adapters</Header>}>
        {adapters.length > 0 ? (
          <SpaceBetween size="l">
            {primaryAdapters.length > 0 ? (
              <SpaceBetween size="l">
                {primaryAdapters.map((adapter, idx) => renderAdapter(adapter, idx))}
              </SpaceBetween>
            ) : (
              <Box variant="p" color="text-body-secondary">
                No primary adapters found.
              </Box>
            )}
            {loopbackAdapters.length > 0 && (
              <ExpandableSection
                headerText={`Loopback & local adapters (${loopbackAdapters.length})`}
              >
                <SpaceBetween size="l">
                  {loopbackAdapters.map((adapter, idx) =>
                    renderAdapter(adapter, primaryAdapters.length + idx)
                  )}
                </SpaceBetween>
              </ExpandableSection>
            )}
          </SpaceBetween>
        ) : (
          <Box textAlign="center" padding="l">
            <Box variant="p" color="text-body-secondary">
              No network adapters found
            </Box>
          </Box>
        )}
      </Container>
    </SpaceBetween>
  );
}
