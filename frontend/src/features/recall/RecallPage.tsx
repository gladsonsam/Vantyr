import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useSearchParams, useLocation } from "react-router-dom";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectValue,
  SelectTrigger,
} from "@/components/ui/select";
import { RecallDayPanel } from "@/features/recall/components/RecallDayPanel";
import { RecallView } from "@/features/recall/components/RecallView";
import { agentQueries } from "@/api/queries/agents";
import { recallQueries } from "@/api/queries/recall";
import { parseRecallParams, parseRecallSearchParams, writeRecallSearchParams } from "@/features/recall/lib/recallUrl";
import type { SavedSearch } from "@/features/recall/lib/recallRetrieval";
import type { Agent } from "@/api/types";

/**
 * Screen history / "Recall" — DVR playback of persisted screen keyframes.
 *
 * Page chrome (title, sidebar, top bar) comes from the dashboard layout; this
 * page renders plain content only. The view itself lives in
 * `components/recall` so an agent's own detail page can embed the same player
 * scoped to that agent.
 */
const NO_AGENTS: Agent[] = [];

export function RecallPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const [restored, setRestored] = useState(() => ({ ...parseRecallParams(searchParams), ...parseRecallSearchParams(searchParams), key: location.key }));
  const locationRef = useRef(location);
  locationRef.current = location;
  const restoredRef = useRef(restored);
  restoredRef.current = restored;
  const writtenSearch = useRef<string | null>(null);
  // `?agent=` seeds the selection, so a link can point at a specific machine.
  const [agentId, setAgentId] = useState<string | null>(() => searchParams.get("agent"));

  // Agents that actually have recall history — the full fleet list would mostly be
  // devices with nothing to replay.
  const [overviewQuery, devicesQuery] = useQueries({ queries: [agentQueries.overview(), recallQueries.devices()] });
  const loadingAgents = overviewQuery.isPending || devicesQuery.isPending;
  const error = overviewQuery.isError || devicesQuery.isError ? "Failed to load agents." : null;
  const agentsWithHistory = useMemo<Agent[] | null>(() => {
    if (!overviewQuery.data || !devicesQuery.data) return null;
    const withHistory = new Set(devicesQuery.data.agent_ids);
    return overviewQuery.data.agents.filter((a) => withHistory.has(a.id));
  }, [overviewQuery.data, devicesQuery.data]);
  const agents = error ? NO_AGENTS : agentsWithHistory ?? NO_AGENTS;
  useEffect(() => {
    if (!agentsWithHistory) return;
    // Prefer an online agent as the default selection.
    const first = agentsWithHistory.find((a) => a.online) ?? agentsWithHistory[0];
    setAgentId((cur) => cur ?? first?.id ?? null);
  }, [agentsWithHistory]);

  // Internal playback writes keep the mounted view; navigation restores a fresh scope.
  useEffect(() => {
    if (writtenSearch.current === location.search) {
      writtenSearch.current = null;
      return;
    }
    if (syncTimer.current) clearTimeout(syncTimer.current);
    const next = parseRecallParams(new URLSearchParams(location.search));
    setRestored({ ...next, ...parseRecallSearchParams(new URLSearchParams(location.search)), key: location.key });
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
  const syncSearch=useCallback((search:SavedSearch|null)=>{
    if(restored.key!==restoredRef.current.key)return;
    const next=new URLSearchParams(locationRef.current.search);
    if(agentId)next.set("agent",agentId);
    writeRecallSearchParams(next,search);
    const value=`?${next}`;
    if(value!==locationRef.current.search){writtenSearch.current=value;setSearchParams(next,{replace:true});}
  },[agentId,setSearchParams,restored.key]);
  useEffect(
    () => () => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
    },
    [agentId, restored.key],
  );

  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === agentId) ?? null,
    [agents, agentId],
  );

  const unavailableAgent = !!agentId && !loadingAgents && !error && !selectedAgent;

  const picker = (
    <div className="grid w-full min-w-0 gap-1.5 sm:max-w-70">
      <Label>Agent</Label>
      <Select
        value={selectedAgent?.id ?? ""}
        onValueChange={(value) => {
          if (syncTimer.current) clearTimeout(syncTimer.current);
          const next = new URLSearchParams();
          if (value) next.set("agent", value);
          setSearchParams(next);
        }}
        disabled={loadingAgents || agents.length === 0}
      >
        <SelectTrigger
          className="h-9 w-full"
          aria-label="Agent with screen history"
        >
          <SelectValue
            placeholder={loadingAgents ? "Loading agents…" : "Select an agent"}
          />
        </SelectTrigger>
        <SelectContent>
          {agents.length === 0 ? (
            <SelectItem value="__empty" disabled>
              No agents
            </SelectItem>
          ) : (
            agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                <span
                  aria-hidden="true"
                  className={
                    a.online
                      ? "size-2 shrink-0 rounded-full bg-success"
                      : "size-2 shrink-0 rounded-full bg-muted-foreground/50"
                  }
                />
                <span className="truncate">{a.name}</span>
                <span className="text-muted-foreground">{a.online ? "online" : "offline"}</span>
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
      {unavailableAgent && (
        <p className="text-xs text-muted-foreground">
          Unavailable agent ({agentId})
        </p>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {unavailableAgent && (
        <div role="status" className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
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
        initialSearch={restored.search}
        initialSearchError={restored.error}
        onSearchStateChange={syncSearch}
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
  );
}
