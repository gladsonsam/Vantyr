import { Alert, Box, Button, Container, FormField, Header, SegmentedControl, Select, SpaceBetween, Toggle, SelectProps } from "../ui/console";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { AuditTab } from "./AuditTab";

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

  const sourceOptions: SelectProps.Options = useMemo(
    () =>
      sources.map((s) => ({
        label: s.label,
        value: s.id,
        description: s.path,
      })),
    [sources],
  );

  const selectedOption = useMemo(
    () => sourceOptions.find((o) => o.value === sourceId) ?? null,
    [sourceOptions, sourceId],
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

    if (!initialScrollDoneRef.current) {
      el.scrollTop = el.scrollHeight;
      initialScrollDoneRef.current = true;
      return;
    }

    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [view, logText]);

  if (view === "audit") {
    return (
      <SpaceBetween size="l">
        <SegmentedControl
          label="Logs"
          selectedId={view}
          onChange={({ detail }) => setView(detail.selectedId as SubView)}
          options={[
            { id: "agent", text: "Agent logs" },
            { id: "audit", text: "Audit log" },
          ]}
        />
        <AuditTab agentId={agentId} subheader="Central audit log filtered to this agent." />
      </SpaceBetween>
    );
  }

  return (
    <SpaceBetween size="l">
      <SegmentedControl
        label="Logs"
        selectedId={view}
        onChange={({ detail }) => setView(detail.selectedId as SubView)}
        options={[
          { id: "agent", text: "Agent logs" },
          { id: "audit", text: "Audit log" },
        ]}
      />

      {error ? <Alert type="error">{error}</Alert> : null}

      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, gap: 12 }}>
        <Container
          header={
            <Header
              variant="h2"
              actions={
                <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                  <Toggle checked={autoRefresh} onChange={({ detail }) => setAutoRefresh(detail.checked)}>
                    Auto-refresh
                  </Toggle>
                  <Button loading={refreshing} onClick={() => void refreshTail(true)}>
                    Refresh
                  </Button>
                </SpaceBetween>
              }
            >
              Agent logs
            </Header>
          }
        >
          <SpaceBetween size="m">
            <FormField label="Log file" description="Last ~512 KiB (pulled live from the connected agent).">
              <Select
                selectedOption={selectedOption}
                options={sourceOptions}
                loadingText="Loading logs…"
                statusType={loadingSources ? "loading" : "finished"}
                placeholder="Choose a log"
                empty="No log sources"
                onChange={({ detail }) => {
                  const v = detail.selectedOption?.value;
                  if (v) setSourceId(v);
                }}
              />
            </FormField>
            <Box variant="small" color="text-body-secondary">
              Tip: scroll up to pause “follow”; scroll back to bottom to re-pin.
            </Box>
          </SpaceBetween>
        </Container>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            border: "1px solid var(--line)",
            borderRadius: 6,
            background: "var(--card-2)",
            overflow: "hidden",
          }}
        >
          <textarea
            ref={viewportRef}
            aria-label="Agent log output"
            value={logText || (loadingSources ? "Loading…" : "No log data yet.")}
            readOnly
            spellCheck={false}
            wrap="off"
            onScroll={() => {
              const el = viewportRef.current;
              if (!el) return;
              const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
              stickToBottomRef.current = distanceFromBottom <= 8;
            }}
            style={{
              width: "100%",
              height: "100%",
              display: "block",
              boxSizing: "border-box",
              border: "none",
              resize: "none",
              background: "transparent",
              padding: 12,
              whiteSpace: "pre",
              overflow: "auto",
              fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
              fontSize: 12,
              lineHeight: 1.45,
              color: "var(--tx)",
            }}
            onFocus={(e) => {
              e.currentTarget.style.outline = "2px solid var(--gr)";
              e.currentTarget.style.outlineOffset = "2px";
            }}
            onBlur={(e) => {
              e.currentTarget.style.outline = "none";
              e.currentTarget.style.outlineOffset = "0";
            }}
          />
        </div>
      </div>
    </SpaceBetween>
  );
}
