import { ArrowDownToLine, Search, WrapText, X } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@vantyr/ui/components/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { Tabs, TabsList, TabsTrigger } from "@vantyr/ui/components/tabs";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentQueries } from "@/api/queries/agents";
import { errorText } from "@/api";
import { CopyTextButton } from "@/components/common/CopyTextButton";
import { CopyValue } from "@/components/common/CopyValue";
import { RefreshButton } from "@/components/common/RefreshButton";
import { Switch } from "@/components/common/SettingsSwitch";
import { LogViewer } from "@/features/agent-detail/components/LogViewer";
import { LoadFailed } from "@/features/agent-detail/components/MonitoringToolbar";
import { filterLog, logCountLabel, logPlaceholder } from "@/features/agent-detail/lib/logView";
import { LOG_POLL_MS, isDefinitiveFailure, logPollInterval, logRetry } from "@/features/agent-detail/lib/logPolling";
import { AuditTab } from "@/features/logs/AuditTab";
import { cn } from "@/lib/utils";

type SubView = "agent" | "audit";

const NO_SOURCES: { id: string; label: string; path: string }[] = [];

export function AgentLogsTab({ agentId }: { agentId: string }) {
  const [view, setView] = useState<SubView>("agent");
  return (
    <div className="flex flex-col gap-3">
      <Tabs value={view} onValueChange={(v) => setView(v as SubView)}>
        <TabsList aria-label="Logs">
          <TabsTrigger value="agent">Device logs</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>
      </Tabs>
      {view === "audit" ? <AuditTab agentId={agentId} /> : <DeviceLog key={agentId} agentId={agentId} />}
    </div>
  );
}

function DeviceLog({ agentId }: { agentId: string }) {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [following, setFollowing] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [filter, setFilter] = useState("");
  const log = useAgentLogData(agentId, autoRefresh);

  const selectedSource = useMemo(() => log.sources.find((s) => s.id === log.sourceId) ?? null, [log.sources, log.sourceId]);
  const filtered = useMemo(() => filterLog(log.logText, filter), [log.logText, filter]);
  const placeholder = logPlaceholder({ failed: log.tailFailed, waiting: log.loadingSources || log.tailPending, filtering: filter.trim() !== "", total: filtered.total });

  return (
    <div className="overflow-hidden rounded-xl bg-card">
      <div className="flex flex-col gap-3 p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <SourcePicker
            sources={log.sources}
            value={log.sourceId}
            loading={log.loadingSources}
            onChange={(id) => { log.setSourceId(id); setFollowing(true); }}
          />
          <FilterInput value={filter} onChange={setFilter} />
          <RefreshButton
            onClick={() => void log.refresh()}
            loading={log.refreshing}
            label={log.pollingPaused ? "Retry loading the log" : "Refresh log"}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted-foreground">
          <p role="status" className="min-w-0 basis-full tabular-nums sm:flex-1 sm:basis-0">
            <LogState autoRefresh={autoRefresh} following={following} paused={log.pollingPaused} count={logCountLabel(filtered)} empty={filtered.total === 0} />
          </p>
          {autoRefresh && !following && (
            <Button variant="outline" size="sm" className="pointer-coarse:h-9" onClick={() => setFollowing(true)}>
              <ArrowDownToLine /> Jump to latest
            </Button>
          )}
          <label className="flex cursor-pointer items-center gap-2 pointer-coarse:min-h-9">
            <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} aria-label="Auto-refresh" />
            Auto-refresh
          </label>
          <Button variant="outline" size="sm" className="pointer-coarse:h-9" aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
            <WrapText className={cn(wrap && "text-primary")} /> Wrap lines
          </Button>
          <CopyTextButton text={filtered.text} label="Copy" disabled={!filtered.text} />
        </div>
      </div>
      {log.error ? (
        <LoadFailed what={log.pollingPaused ? "the log (auto-refresh paused)" : "the log"} detail={log.error} onRetry={() => void log.refresh()} />
      ) : null}
      <div className="mt-3 h-[clamp(14rem,calc(100dvh-22rem),40rem)] border-t border-foreground/[0.06] bg-muted/40">
        <LogViewer
          label="Device log output"
          text={filtered.text}
          placeholder={placeholder}
          wrap={wrap}
          following={following}
          onFollowingChange={setFollowing}
        />
      </div>
      {selectedSource?.path && (
        <div className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
          <CopyValue text={selectedSource.path} label="log path" mono className="text-xs" />
        </div>
      )}
    </div>
  );
}

function SourcePicker({ sources, value, loading, onChange }: {
  sources: { id: string; label: string; path: string }[]; value: string; loading: boolean; onChange: (id: string) => void;
}) {
  return (
    <Select value={value} disabled={loading && sources.length === 0} onValueChange={(v) => { if (v) onChange(v); }}>
      <SelectTrigger aria-label="Log file" className="w-full min-w-0 sm:w-72">
        <SelectValue placeholder={loading ? "Loading…" : "Choose a log"} />
      </SelectTrigger>
      <SelectContent>
        {sources.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">No logs on this device</div>
        ) : (
          sources.map((s) => (
            <SelectItem key={s.id} value={s.id} title={s.path}>
              {s.label}
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}

function FilterInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <InputGroup className="h-9 min-w-0 flex-1 basis-48">
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
      <InputGroupInput aria-label="Filter log lines" placeholder="Filter lines" value={value} onChange={(e) => onChange(e.target.value)} />
      {value && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Clear filter" onClick={() => onChange("")}>
            <X />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

function LogState({ autoRefresh, following, paused, count, empty }: {
  autoRefresh: boolean; following: boolean; paused: boolean; count: string; empty: boolean;
}) {
  const live = autoRefresh && !paused;
  const state = paused ? "Auto-refresh paused"
    : !autoRefresh ? "Auto-refresh off"
    : following ? `Live · every ${LOG_POLL_MS / 1000} s`
    : "Paused while you read";
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      <span className="inline-flex items-center gap-1.5">
        <span className={cn("size-[7px] rounded-full", live && following ? "bg-success" : "bg-muted-foreground/50")} aria-hidden="true" />
        {state}
      </span>
      {!empty && <span>· {count} · last 512 KiB</span>}
    </span>
  );
}

function useAgentLogData(agentId: string, autoRefresh: boolean) {
  const [sourceId, setSourceId] = useState<string>("local_agent");
  const [refreshing, setRefreshing] = useState(false);

  const sourcesQuery = useQuery(agentQueries.logSources(agentId));
  const sources = sourcesQuery.isError ? NO_SOURCES : sourcesQuery.data?.sources ?? NO_SOURCES;
  const loadingSources = sourcesQuery.isFetching;
  // Fall back to the first source the agent offers when the current pick isn't one of them.
  if (sources.length > 0 && !sources.some((s) => s.id === sourceId)) {
    setSourceId(sources[0].id);
  }

  const tailQuery = useQuery({
    ...agentQueries.logTail(agentId, sourceId),
    refetchInterval: (query) => logPollInterval(autoRefresh, query.state.error),
    retry: logRetry,
  });
  const logText = tailQuery.isError ? "" : tailQuery.data?.text ?? "";
  const failure = sourcesQuery.error ?? tailQuery.error;
  const error = failure ? errorText(failure) : null;
  const pollingPaused = autoRefresh && isDefinitiveFailure(tailQuery.error);

  /** Reload the tail, and the list of logs too when that is what failed. */
  const refresh = async () => {
    setRefreshing(true);
    try {
      if (sourcesQuery.isError) await sourcesQuery.refetch();
      await tailQuery.refetch();
    } finally {
      setRefreshing(false);
    }
  };

  return { sourceId, setSourceId, refreshing, sources, loadingSources, logText, error, pollingPaused, refresh, tailFailed: tailQuery.isError, tailPending: tailQuery.isPending };
}
