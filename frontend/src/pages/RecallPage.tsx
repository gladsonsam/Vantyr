import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useLocation } from "react-router-dom";
import { Box, ContentLayout, Header, Select } from "../components/ui/console";
import { RecallDayPanel } from "../components/recall/RecallDayPanel";
import { RecallView } from "../components/recall/RecallView";
import { api } from "../lib/api";
import { parseRecallParams } from "../lib/recallUrl";
import type { Agent } from "../lib/types";

/**
 * Screen history / "Recall" — DVR playback of persisted screen keyframes.
 *
 * Page chrome and the fleet-wide device picker only; the view itself lives in
 * `components/recall` so an agent's own detail page can embed the same player
 * scoped to that agent.
 */
export function RecallPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const [restored, setRestored] = useState(() => ({ ...parseRecallParams(searchParams), key: location.key }));
  const locationRef = useRef(location);
  locationRef.current = location;
  const restoredRef = useRef(restored);
  restoredRef.current = restored;
  const writtenSearch = useRef<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  // `?agent=` seeds the selection, so a link can point at a specific machine.
  const [agentId, setAgentId] = useState<string | null>(() => searchParams.get("agent"));
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Internal playback writes keep the mounted view; navigation restores a fresh scope.
  useEffect(() => {
    if (writtenSearch.current === location.search) {
      writtenSearch.current = null;
      return;
    }
    if (syncTimer.current) clearTimeout(syncTimer.current);
    const next = parseRecallParams(new URLSearchParams(location.search));
    setRestored({ ...next, key: location.key });
    setAgentId(next.agent);
  }, [location.search, location.key]);

  /**
   * Mirror the view's state into the query string, so any moment is linkable.
   *
   * Debounced, and `replace` rather than push: playback moves the playhead ten
   * times a second, which would otherwise mean ten `history.replaceState` calls a
   * second and a back button buried under thousands of entries. The URL only needs
   * to be right once the playhead settles.
   */
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncUrl = useCallback(
    (state: { day: string; atMs: number; monitor: number | null }) => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
      syncTimer.current = setTimeout(() => {
        if (restored.key !== restoredRef.current.key || !agentId) return;
        const next = new URLSearchParams(locationRef.current.search);
        next.set("agent", agentId);
        next.set("day", state.day);
        next.set("at", new Date(state.atMs).toISOString());
        if (state.monitor != null) next.set("monitor", String(state.monitor));
        else next.delete("monitor");
        const search = `?${next.toString()}`;
        if (search === locationRef.current.search) return;
        writtenSearch.current = search;
        setSearchParams(next, { replace: true });
      }, 500);
    },
    [agentId, setSearchParams, restored.key],
  );
  useEffect(
    () => () => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
    },
    [agentId, restored.key],
  );

  // Agents that actually have recall history — the full fleet list would mostly be
  // devices with nothing to replay.
  useEffect(() => {
    let alive = true;
    setLoadingAgents(true);
    Promise.all([api.agentsOverview(), api.historyDevices()])
      .then(([overviewRes, devicesRes]) => {
        if (!alive) return;
        const withHistory = new Set(devicesRes.agent_ids);
        const filtered = overviewRes.agents.filter((a) => withHistory.has(a.id));
        setAgents(filtered);
        // Prefer an online agent as the default selection.
        const first = filtered.find((a) => a.online) ?? filtered[0];
        setAgentId((cur) => cur ?? first?.id ?? null);
      })
      .catch(() => alive && setError("Failed to load agents."))
      .finally(() => alive && setLoadingAgents(false));
    return () => {
      alive = false;
    };
  }, []);

  const agentOptions = useMemo(
    () =>
      agents.map((a) => ({
        value: a.id,
        label: a.name,
        labelTag: a.online ? "online" : "offline",
      })),
    [agents],
  );
  const selectedOption = useMemo(
    () => agentOptions.find((o) => o.value === agentId) ?? null,
    [agentOptions, agentId],
  );

  const unavailableAgent = !!agentId && !loadingAgents && !error && !selectedOption;

  const picker = (
    <div className="recall-agent-picker" style={{ minWidth: 0, width: "min(100%, 280px)" }}>
      <Box fontSize="body-s" color="text-body-secondary" margin={{ bottom: "xxs" }}>
        Agent
      </Box>
      <Select
        selectedOption={selectedOption ?? (agentId ? {
          value: agentId,
          label: loadingAgents ? "Loading linked agent…" : `Unavailable agent (${agentId})`,
        } : null)}
        onChange={({ detail }) => {
          if (syncTimer.current) clearTimeout(syncTimer.current);
          const next = new URLSearchParams();
          if (detail.selectedOption?.value) next.set("agent", detail.selectedOption.value);
          setSearchParams(next);
        }}
        options={agentOptions}
        placeholder={loadingAgents ? "Loading agents…" : "Select an agent"}
        disabled={loadingAgents || agents.length === 0}
        empty="No agents"
      />
    </div>
  );

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Scrub and replay persisted screen keyframes captured on meaningful change (window/URL focus + active heartbeat). Frames are strategic, not fixed-fps — gaps mean no new frame was captured."
        >
          Recall
        </Header>
      }
    >
      <div className="vantyr-admin-page sx-console">
        {error && (
          <Box color="text-status-error" fontSize="body-s" padding={{ bottom: "m" }}>
            {error}
          </Box>
        )}
        {unavailableAgent && (
          <div role="status" style={{ marginBottom: 16, overflowWrap: "anywhere", color: "var(--tx-2)" }}>
            Linked agent “{agentId}” is unavailable or has no recorded Recall history.
            {agents.length > 0 ? " Select an agent with history from the Agent picker." : " No agents with Recall history are currently available."}
          </div>
        )}
        <RecallView
          key={`${restored.key}:${agentId}`}
          agentId={agentId}
          agentPicker={picker}
          initialAtIso={restored.at}
          initialDay={restored.day}
          initialMonitor={restored.monitor}
          onStateChange={syncUrl}
          emptyMessage={
            agents.length === 0 && !loadingAgents
              ? "No agents have recorded screen history yet."
              : undefined
          }
        >
          {(ctx) => <RecallDayPanel {...ctx} />}
        </RecallView>
      </div>
    </ContentLayout>
  );
}
