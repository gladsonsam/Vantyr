import { RefreshCw, Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api";
import { AuditTab } from "@/features/logs/AuditTab";

type SubView = "agent" | "audit";

export function AgentLogsTab({ agentId }: { agentId: string }) {
  const [view, setView] = useState<SubView>("agent");
  const [sources, setSources] = useState<{ id: string; label: string; path: string }[]>([]);
  const [sourceId, setSourceId] = useState<string>("local_agent");
  const [loadingSources, setLoadingSources] = useState(false);

  const [logText, setLogText] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const viewportRef = useRef<HTMLTextAreaElement | null>(null);
  const stickToBottomRef = useRef(true);
  const initialScrollDoneRef = useRef(false);

  const selectedSource = useMemo(
    () => sources.find((s) => s.id === sourceId) ?? null,
    [sources, sourceId],
  );

  const refreshSources = useCallback(async () => {
    setLoadingSources(true);
    setError(null);
    try {
      const r = await api.agentLogSources(agentId);
      setSources(r.sources);
      if (r.sources.length > 0 && !r.sources.some((s) => s.id === sourceId)) {
        setSourceId(r.sources[0].id);
      }
    } catch (e: unknown) {
      setSources([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingSources(false);
    }
  }, [agentId, sourceId]);

  const refreshTail = useCallback(
    async (manual: boolean) => {
      if (manual) setRefreshing(true);
      setError(null);
      try {
        const r = await api.agentLogTail(agentId, { kind: sourceId, maxKb: 512 });
        setLogText(r.text);
      } catch (e: unknown) {
        setLogText("");
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (manual) setRefreshing(false);
      }
    },
    [agentId, sourceId],
  );

  const refreshTailRef = useRef(refreshTail);

  useEffect(() => {
    refreshTailRef.current = refreshTail;
  }, [refreshTail]);

  useEffect(() => {
    if (view !== "agent") return;
    void refreshSources();
  }, [view, refreshSources]);

  useEffect(() => {
    if (view !== "agent") return;
    stickToBottomRef.current = true;
    initialScrollDoneRef.current = false;
    void refreshTail(false);
  }, [view, sourceId, refreshTail]);

  useEffect(() => {
    if (view !== "agent" || !autoRefresh) return;
    const id = setInterval(() => refreshTailRef.current(false), 2000);
    return () => clearInterval(id);
  }, [view, autoRefresh]);

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
              <Button variant="outline" size="sm" disabled={refreshing} onClick={() => void refreshTail(true)}>
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
