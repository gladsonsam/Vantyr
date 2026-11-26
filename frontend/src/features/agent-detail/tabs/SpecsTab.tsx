import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Cpu, HardDrive, Network } from "lucide-react";
import { Card, CardContent } from "@vantyr/ui/components/card";
import { Spinner } from "@vantyr/ui/components/spinner";
import { Button } from "@vantyr/ui/components/button";
import { agentQueries } from "@/api/queries/agents";
import type { AgentInfo } from "@/api/types";
import { cn } from "@/lib/utils";
import { CopyValue } from "@/components/common/CopyValue";
import { MetricRing } from "@/components/common/MetricRing";
import { DetailSection } from "@/components/common/resource-detail/DetailSection";
import { KeyValueCard, KeyValueGrid } from "@/components/common/resource-detail/KeyValueCard";
import { ResourceHistory } from "@/features/agent-detail/components/ResourceHistory";
import {
  capabilityLabel,
  capabilityValueTone,
  type CapabilityKey,
} from "@/features/agent-detail/lib/agentCapabilities";
import {
  driveUsage,
  formatDisplays,
  formatGb,
  formatMemoryGb,
  formatProcessor,
  mountAddsInfo,
  partitionAdapters,
  partitionIpAddresses,
  presentFacts,
  uniqueValues,
  type Fact,
} from "@/features/agent-detail/lib/specs";

type Adapter = NonNullable<AgentInfo["adapters"]>[number];

/** A labelled value; identifiers and paths use the UI font and copy with one press. */
function FactList({ facts }: { facts: Fact[] }) {
  if (facts.length === 0) return null;
  return (
    <KeyValueGrid>
      {facts.map((fact) => (
        <KeyValueCard key={fact.label} label={fact.label} format="custom">
          <div className="text-sm wrap-break-word text-foreground">
            {fact.copy ? (
              <CopyValue text={fact.value} label={fact.label.toLowerCase()} mono />
            ) : (
              fact.value
            )}
          </div>
        </KeyValueCard>
      ))}
    </KeyValueGrid>
  );
}

/** Secondary data behind one line that says what is inside, so the page stays short until asked. */
function Section({
  title,
  summary,
  children,
}: {
  title: string;
  summary?: string;
  children: ReactNode;
}) {
  return (
    <details className="group rounded-xl border border-border/70 bg-card/10 px-4 py-3">
      <summary className="flex min-h-7 cursor-pointer list-none items-center justify-between gap-3 rounded-md text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          {title}
          {summary ? (
            <span className="truncate text-xs font-normal text-muted-foreground">{summary}</span>
          ) : null}
        </span>
        <ChevronDown
          size={16}
          className="shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="pt-3">{children}</div>
    </details>
  );
}

interface SpecsTabProps {
  agentId: string;
  cachedInfo?: AgentInfo | null;
  /** Kept for caller compatibility; uptime now lives in the page rail. */
  agentOnline?: boolean;
}

export function SpecsTab({ agentId, cachedInfo }: SpecsTabProps) {
  // Live info pushed over the WebSocket wins; otherwise fetch the last stored snapshot.
  const infoQuery = useQuery({ ...agentQueries.info(agentId), enabled: !cachedInfo });

  const info: AgentInfo | null = cachedInfo || infoQuery.data?.info || null;
  const loading = !cachedInfo && infoQuery.isPending;
  const failed = !cachedInfo && infoQuery.isError;

  // Resource history is independent telemetry (the `agent_metrics` time-series)
  // and must stay visible even when the system-info snapshot is loading, errored
  // or absent — otherwise it disappears for offline agents that still have
  // historical samples.
  if (loading || failed || !info) {
    return (
      <SpecsUnavailable
        agentId={agentId}
        loading={loading}
        failed={failed}
        onRetry={() => void infoQuery.refetch()}
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <SystemSpecs info={info} />
      <DriveSpecs info={info} />
      <NetworkSpecs info={info} />
      <ResourceHistory agentId={agentId} />
    </div>
  );
}

function SpecsUnavailable({
  agentId,
  loading,
  failed,
  onRetry,
}: {
  agentId: string;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-3 p-10 text-center">
          {loading ? (
            <Spinner className="size-8" aria-label="Loading system information" />
          ) : (
            <>
              <p
                role={failed ? "alert" : undefined}
                className={cn("text-sm", failed ? "text-destructive" : "text-muted-foreground")}
              >
                {failed
                  ? "Couldn’t load system info."
                  : "This device hasn’t reported its specs yet."}
              </p>
              {failed ? (
                <Button variant="outline" size="sm" onClick={onRetry}>
                  Try again
                </Button>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
      <ResourceHistory agentId={agentId} />
    </div>
  );
}

function SystemSpecs({ info }: { info: AgentInfo }) {
  const facts = presentFacts([
    {
      label: "Device",
      value: [info.system_manufacturer, info.system_model].filter(Boolean).join(" "),
    },
    { label: "Operating system", value: [info.os_name, info.os_version].filter(Boolean).join(" ") },
    { label: "Signed in", value: info.current_user },
    { label: "Processor", value: formatProcessor(info) },
    { label: "Memory", value: formatMemoryGb(info.memory_total_mb) },
    { label: "Displays", value: formatDisplays(info.monitors) },
    { label: "Time zone", value: info.timezone },
  ]);
  return (
    <DetailSection title="System" icon={Cpu}>
      <div className="flex flex-col gap-4">
        {facts.length > 0 ? (
          <FactList facts={facts} />
        ) : (
          <p className="text-sm text-muted-foreground">No system details reported.</p>
        )}
        <HardwareIds info={info} />
        <InstallConfiguration info={info} />
        <Capabilities info={info} />
      </div>
    </DetailSection>
  );
}

function HardwareIds({ info }: { info: AgentInfo }) {
  const facts = presentFacts([
    { label: "System serial", value: info.system_serial, copy: true },
    {
      label: "Motherboard",
      value: [info.motherboard_manufacturer, info.motherboard_model].filter(Boolean).join(" "),
    },
    { label: "OS build", value: info.os_long_version },
    { label: "Kernel", value: info.kernel_version },
  ]);
  if (facts.length === 0) return null;
  return (
    <Section
      title="Hardware identifiers"
      summary={facts.map((fact) => fact.label.toLowerCase()).join(", ")}
    >
      <FactList facts={facts} />
    </Section>
  );
}

function InstallConfiguration({ info }: { info: AgentInfo }) {
  const facts = presentFacts([
    { label: "Configured name", value: info.config_agent_name },
    { label: "Server URL", value: info.config_server_url, copy: true },
    { label: "Install path", value: info.install_path, copy: true },
    { label: "Config path", value: info.config_path, copy: true },
    { label: "Machine config path", value: info.machine_config_path, copy: true },
    {
      label: "UI password set",
      value:
        info.config_ui_password_set === undefined ? "" : info.config_ui_password_set ? "Yes" : "No",
    },
  ]);
  if (facts.length === 0) return null;
  return (
    <Section
      title="Install & config"
      summary={facts
        .map((fact) => fact.label.toLowerCase())
        .slice(0, 4)
        .join(", ")}
    >
      <FactList facts={facts} />
    </Section>
  );
}

const TONE_CLASS = {
  ok: "text-foreground",
  caution: "text-warning",
  off: "text-muted-foreground",
} as const;

function Capabilities({ info }: { info: AgentInfo }) {
  const entries = Object.entries(info.capabilities ?? {})
    .map(([key, value]) => [key, `${value ?? ""}`.trim()] as const)
    .filter(([, value]) => value !== "");
  if (entries.length === 0) return null;
  const tones = entries.map(([, value]) => capabilityValueTone(value));
  const attention = tones.filter((tone) => tone !== "ok").length;
  return (
    <Section
      title="Capabilities"
      summary={
        attention > 0
          ? `${entries.length - attention} of ${entries.length} fully available`
          : `${entries.length} available`
      }
    >
      <KeyValueGrid>
        {entries.map(([key, value], index) => (
          <KeyValueCard
            key={key}
            label={capabilityLabel(key as CapabilityKey)}
            format="custom"
          >
            <div className={cn("text-sm wrap-break-word", TONE_CLASS[tones[index]])}>
              {value.replace(/_/g, " ")}
            </div>
          </KeyValueCard>
        ))}
      </KeyValueGrid>
    </Section>
  );
}

function usageTone(pct: number): string {
  if (pct >= 90) return "bg-destructive";
  if (pct >= 80) return "bg-warning";
  return "bg-primary";
}

function DriveSpecs({ info }: { info: AgentInfo }) {
  const drives = info.drives ?? [];
  const totalFree = drives.reduce((sum, drive) => sum + (drive.available_gb ?? 0), 0);
  return (
    <DetailSection title="Storage" icon={HardDrive}>
      <div className="grid gap-4 lg:grid-cols-2">
        {drives.length > 1 ? (
          <p className="text-[13px] lg:col-span-2 text-muted-foreground tabular-nums">
            {drives.length} drives · {formatGb(totalFree)} free
          </p>
        ) : null}
        {drives.length === 0 ? (
          <p className="text-sm text-muted-foreground lg:col-span-2">This device reported no drives.</p>
        ) : null}
        {drives.map((drive, idx) => {
          const usage = driveUsage(drive);
          const name = drive.name || drive.mount_point || `Drive ${idx + 1}`;
          const known = usage.total > 0;
          const summary = known
            ? `${usage.pct}% used, ${formatGb(usage.free)} free of ${formatGb(usage.total)}`
            : "Size not reported";
          return (
            <div
              key={`${drive.mount_point ?? ""}|${drive.name ?? ""}`}
              className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card/10 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5">
                <h3 className="flex flex-wrap items-center gap-x-2 font-heading text-sm font-medium">
                  {known ? (
                    <MetricRing
                      percent={usage.pct}
                      variant="disk"
                      tone={usage.pct >= 90 ? "destructive" : usage.pct >= 80 ? "warning" : "default"}
                      size={28}
                      stroke={4}
                      className="mr-1"
                    />
                  ) : null}
                  {name}
                  {drive.file_system ? (
                    <span className="text-xs font-normal text-muted-foreground">
                      {drive.file_system}
                    </span>
                  ) : null}
                  {mountAddsInfo(drive) ? (
                    <span className="font-sans text-xs font-normal text-muted-foreground">
                      {drive.mount_point}
                    </span>
                  ) : null}
                </h3>
                <span
                  className="text-[13px] text-muted-foreground tabular-nums"
                  title={
                    known
                      ? `${usage.free.toFixed(2)} GB free of ${usage.total.toFixed(2)} GB`
                      : undefined
                  }
                >
                  {known
                    ? `${formatGb(usage.free)} free of ${formatGb(usage.total)}`
                    : "Size not reported"}
                </span>
              </div>
              {known ? (
                <div
                  className="h-2 w-full overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-label={`${name} usage`}
                  aria-valuenow={usage.pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuetext={summary}
                >
                  <div
                    className={cn("h-full rounded-full transition-[width]", usageTone(usage.pct))}
                    style={{ width: `${usage.pct}%` }}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </DetailSection>
  );
}

const adapterKey = (adapter: Adapter) =>
  `${adapter.name ?? ""}|${adapter.mac ?? ""}|${(adapter.ips ?? []).join(",")}`;

function AdapterRow({ adapter, index }: { adapter: Adapter; index: number }) {
  const { v4, v6 } = partitionIpAddresses(adapter.ips ?? []);
  const gateways = uniqueValues(adapter.gateways);
  const dns = uniqueValues(adapter.dns);
  const name = adapter.name || `Adapter ${index + 1}`;
  const description = adapter.description?.trim();
  const mac = adapter.mac?.trim();
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card/10 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
        <h3 className="flex flex-wrap items-baseline gap-x-2 font-heading text-sm font-medium">
          {name}
          {description && description !== name ? (
            <span className="text-xs font-normal text-muted-foreground">{description}</span>
          ) : null}
        </h3>
        {mac ? (
          <CopyValue text={mac} label="MAC address" mono className="text-muted-foreground" />
        ) : null}
      </div>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <AdapterValues label="IPv4" values={v4} />
        <AdapterValues label="Gateway" values={gateways} />
        <AdapterValues label="DNS" values={dns} />
      </dl>
      {v6.length > 0 ? (
        <details className="group text-[13px]">
          <summary className="inline-flex min-h-7 cursor-pointer list-none items-center gap-1 rounded-md text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none pointer-coarse:min-h-9 [&::-webkit-details-marker]:hidden">
            <ChevronDown
              size={14}
              className="-rotate-90 transition-transform group-open:rotate-0"
              aria-hidden="true"
            />
            IPv6 ({v6.length})
          </summary>
          <div className="flex flex-col items-start gap-0.5 pl-5">
            {v6.map((ip) => (
              <CopyValue key={ip} text={ip} label="IPv6 address" mono />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function AdapterValues({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div className="min-w-0 rounded-xl border border-border/70 p-3">
      <dt className="mb-0.5 text-xs text-muted-foreground">{label}</dt>
      <dd className="flex flex-col items-start">
        {values.map((value) => (
          <CopyValue key={value} text={value} label={`${label} address`} mono />
        ))}
      </dd>
    </div>
  );
}

function NetworkSpecs({ info }: { info: AgentInfo }) {
  const adapters = info.adapters ?? [];
  const { active, inactive } = partitionAdapters(adapters);
  return (
    <DetailSection title="Network" icon={Network}>
      <div className="flex flex-col gap-4">
        {adapters.length === 0 ? (
          <p className="text-sm text-muted-foreground">This device reported no network adapters.</p>
        ) : null}
        {adapters.length > 0 && active.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No adapter has a network connection right now.
          </p>
        ) : null}
        {active.map((adapter, idx) => (
          <AdapterRow key={adapterKey(adapter)} adapter={adapter} index={idx} />
        ))}
        {inactive.length > 0 ? (
          <Section
            title="Not connected & local"
            summary={`${inactive.length} ${inactive.length === 1 ? "adapter" : "adapters"}`}
          >
            <div className="flex flex-col gap-5">
              {inactive.map((adapter, idx) => (
                <AdapterRow
                  key={adapterKey(adapter)}
                  adapter={adapter}
                  index={active.length + idx}
                />
              ))}
            </div>
          </Section>
        ) : null}
      </div>
    </DetailSection>
  );
}
