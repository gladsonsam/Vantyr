import { RefreshCw, Info } from "lucide-react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@vantyr/ui/components/card";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import { Field, FieldDescription, FieldLabel } from "@vantyr/ui/components/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { Spinner } from "@vantyr/ui/components/spinner";
import { Tabs, TabsList, TabsTrigger } from "@vantyr/ui/components/tabs";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentQueries } from "@/api/queries/agents";
import { errorText } from "@/api";
import { AuditTab } from "@/features/logs/AuditTab";

type SubView = "agent" | "audit";

const NO_SOURCES: { id: string; label: string; path: string }[] = [];

export function AgentLogsTab({ agentId }: { agentId: string }) {
  const [view, setView] = useState<SubView>("agent");
  const [sourceId, setSourceId] = useState<string>("local_agent");
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const sourcesQuery = useQuery({ ...agentQueries.logSources(agentId), enabled: view === "agent" });
  const sources = sourcesQuery.isError ? NO_SOURCES : sourcesQuery.data?.sources ?? NO_SOURCES;
  const loadingSources = sourcesQuery.isFetching;
  // Fall back to the first source the agent offers when the current pick isn't one of them.
  if (sources.length > 0 && !sources.some((s) => s.id === sourceId)) {
    setSourceId(sources[0].id);
  }

  const tailQuery = useQuery({
    ...agentQueries.logTail(agentId, sourceId),
    enabled: view === "agent",
    refetchInterval: autoRefresh ? 2000 : false,
  });
  const logText = tailQuery.isError ? "" : tailQuery.data?.text ?? "";
  const failure = sourcesQuery.error ?? tailQuery.error;
  const error = failure ? errorText(failure) : null;

  const refreshTail = async () => {
    setRefreshing(true);
    try {
      await tailQuery.refetch();
    } finally {
      setRefreshing(false);
    }
  };

  const viewportRef = useRef<HTMLTextAreaElement | null>(null);
  const stickToBottomRef = useRef(true);
  const initialScrollDoneRef = useRef(false);

  const selectedSource = useMemo(
    () => sources.find((s) => s.id === sourceId) ?? null,
    [sources, sourceId],
  );

  // A new source (or coming back to this view) starts pinned to the bottom again.
  useEffect(() => {
    if (view !== "agent") return;
    stickToBottomRef.current = true;
    initialScrollDoneRef.current = false;
  }, [view, sourceId, agentId]);

  useEffect(() => {
    if (view !== "agent") return;
    const el = viewportRef.current;
    if (!el) return;

    const scrollToBottom = () => {
      el.scrollTop = el.scrollHeight;
    };

    if (!initialScrollDoneRef.current) {
      setTimeout(scrollToBottom, 50);
      initialScrollDoneRef.current = true;
      return;
    }

    if (stickToBottomRef.current) {
      setTimeout(scrollToBottom, 50);
    }
  }, [view, logText]);

  if (view === "audit") {
    return (
      <div className="flex flex-col gap-6">
        <Tabs value={view} onValueChange={(v) => setView(v as SubView)}>
          <TabsList aria-label="Logs">
            <TabsTrigger value="agent">Agent logs</TabsTrigger>
            <TabsTrigger value="audit">Audit log</TabsTrigger>
          </TabsList>
        </Tabs>
        <AuditTab agentId={agentId} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Tabs value={view} onValueChange={(v) => setView(v as SubView)}>
        <TabsList aria-label="Logs">
          <TabsTrigger value="agent">Agent logs</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>
      </Tabs>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex min-h-0 flex-col gap-3">
        <Card>
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
            <CardTitle>Live tail</CardTitle>
            <div className="flex items-center gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={autoRefresh}
                  onCheckedChange={(checked) => setAutoRefresh(checked === true)}
                  aria-label="Auto-refresh logs"
                />
                Auto-refresh
              </label>
              <Button variant="outline" size="sm" disabled={refreshing} onClick={() => void refreshTail()}>
                {refreshing && <Spinner />} <RefreshCw /> Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Field>
              <FieldLabel htmlFor="agent-log-source">Log file</FieldLabel>
              <FieldDescription>Last ~512 KiB.</FieldDescription>
              <Select
                value={sourceId}
                disabled={loadingSources}
                onValueChange={(v) => { if (v) setSourceId(v); }}
              >
                <SelectTrigger id="agent-log-source" className="w-full">
                  <SelectValue placeholder={loadingSources ? "Loading…" : "Choose a log"} />
                </SelectTrigger>
                <SelectContent>
                  {sources.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">No log sources</div>
                  ) : (
                    sources.map((s) => (
                      <SelectItem key={s.id} value={s.id} title={s.path}>
                        {s.label}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </Field>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Info className="size-3.5" />
              Scroll up to pause following.
            </p>
          </CardContent>
        </Card>

        <div className="h-[500px] overflow-hidden rounded-xl bg-muted/50">
          <textarea
            ref={viewportRef}
            aria-label="Agent log output"
            value={logText || (loadingSources ? "Loading…" : "No log data.")}
            readOnly
            spellCheck={false}
            wrap="off"
            onScroll={() => {
              const el = viewportRef.current;
              if (!el) return;
              const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
              stickToBottomRef.current = distanceFromBottom <= 25;
            }}
            className="block h-full w-full resize-none border-0 bg-transparent p-3 font-mono text-xs leading-relaxed whitespace-pre text-foreground outline-none"
            onFocus={(e) => {
              e.currentTarget.style.outline = "2px solid var(--success)";
              e.currentTarget.style.outlineOffset = "2px";
            }}
            onBlur={(e) => {
              e.currentTarget.style.outline = "none";
              e.currentTarget.style.outlineOffset = "0";
            }}
          />
        </div>
        {selectedSource?.path && (
          <p className="font-mono text-xs text-muted-foreground">{selectedSource.path}</p>
        )}
      </div>
    </div>
  );
}
