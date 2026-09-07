import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Box, ContentLayout, Header, Select } from "../components/ui/console";
import { RecallDayPanel } from "../components/recall/RecallDayPanel";
import { RecallView } from "../components/recall/RecallView";
import { api } from "../lib/api";
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
  const [agents, setAgents] = useState<Agent[]>([]);
  // `?agent=` seeds the selection, so a link can point at a specific machine.
  const [agentId, setAgentId] = useState<string | null>(() => searchParams.get("agent"));
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Read once: these seed the view, and thereafter the view is the source of truth.
  // Re-reading them would fight the sync effect below.
  const [initialAt] = useState<string | null>(() => searchParams.get("at"));

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
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            if (agentId) next.set("agent", agentId);
            next.set("day", state.day);
            next.set("at", new Date(state.atMs).toISOString());
            if (state.monitor != null) next.set("monitor", String(state.monitor));
            else next.delete("monitor");
            return next;
          },
          { replace: true },
        );
      }, 500);
    },
    [agentId, setSearchParams],
  );
  useEffect(
    () => () => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
    },
    [],
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

  const picker = (
    <div style={{ minWidth: 240 }}>
      <Box fontSize="body-s" color="text-body-secondary" margin={{ bottom: "xxs" }}>
        Agent
      </Box>
      <Select
        selectedOption={selectedOption}
        onChange={({ detail }) => setAgentId(detail.selectedOption?.value ?? null)}
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
          description="Scrub and replay persisted screen keyframes captured on meaningful change (window/URL focus + active heartbeat). Frames are strategic, not fixed-fps — gaps mean the machine was idle or unchanged."
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
        <RecallView
          agentId={agentId}
          agentPicker={picker}
          initialAtIso={initialAt}
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
