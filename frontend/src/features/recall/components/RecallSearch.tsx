import { RecallCaptureContext } from "./RecallCaptureContext";
import { contextFiltersActive, EMPTY_CONTEXT_FILTERS, parseRecallFilters } from "@/features/recall/lib/recallContext";
import type { RecallContextFilters } from "@/api/types";
import { fleetServerScope } from "@/hooks/useVerifiedUser";
import { RecallImage } from "./RecallImage";
import { groupSearchHits } from "@/features/recall/lib/recallSearchGroups";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@vantyr/ui/components/button";
import { Input } from "@vantyr/ui/components/input";
import { Label } from "@vantyr/ui/components/label";
import { api, errorText } from "@/api";
import type { ScreenFrameSearchResult } from "@/api/types";
import { deviceTime, parseSavedSearch, readItems, writeItems, type SavedSearch } from "@/features/recall/lib/recallRetrieval";
import type { HistorySearchOpts } from "@/api";
import { shortDateIn, timeIn } from "@/features/recall/lib/recallFormat";
import { onSessionExpired } from "@/api/sessionExpiry";

/** Thumbnail width per result row. */
const RESULT_W = 160;

/** Render a `ts_headline` snippet, bolding the `[[[…]]]`-delimited matches (no HTML). */
function renderSnippet(snippet: string): ReactNode[] {
  return snippet.split(/(\[\[\[.*?\]\]\])/g).map((part, i) => {
    const m = /^\[\[\[(.*?)\]\]\]$/.exec(part);
    return m ? (
      <strong key={i} className="text-success">
        {m[1]}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    );
  });
}

interface RecallSearchProps {
  agentId: string;
  /** Restrict hits to the display being replayed, matching what the player shows. */
  monitor: number | null;
  onSeek: (iso: string, monitor?: number | null, frameId?:number) => void;
  timezone: string | null;
  range?: { fromMs: number; toMs: number };
  preferencesKey?: string | null;
  initialSearch?: SavedSearch | null;
  initialSearchError?: string | null;
  onSearchStateChange?: (search: SavedSearch | null) => void;
}

/** OCR full-text search over an agent's captured screens, with frame previews. */
export function RecallSearch({ agentId, monitor, onSeek, timezone, range, preferencesKey, initialSearch, initialSearchError, onSearchStateChange }: RecallSearchProps) {
  const seedRef=useRef({initialSearch,initialSearchError});
  const seed = initialSearch ? parseSavedSearch(initialSearch) : null;
  const monitorRef=useRef(monitor);
  const lastMonitor=useRef(monitor);
  const [searchMonitor,setSearchMonitor]=useState<number|null>(seed ? seed.monitor : monitor);
  const [query, setQuery] = useState(seed?.query ?? "");
  const [filters, setFilters] = useState<RecallContextFilters>(seed?.filters ?? {...EMPTY_CONTEXT_FILTERS});
  const [restoredBounds, setRestoredBounds] = useState<{from:string;to:string}|null>(seed?.scope === "range" ? {from:seed.from!,to:seed.to!} : null);
  const [linkedError, setLinkedError] = useState(initialSearchError ?? null);
  const subscribeServer = useCallback((change: () => void) => {
    window.addEventListener("storage",change); window.addEventListener("focus",change);
    return () => { window.removeEventListener("storage",change); window.removeEventListener("focus",change); };
  },[]);
  const server = useSyncExternalStore(subscribeServer,fleetServerScope,()=>"");
  const requestScope = JSON.stringify([agentId,monitor,preferencesKey,server]);
  const latestScope = useRef(requestScope);
  const abort = useRef<AbortController|null>(null);
  const stateChange = useRef(onSearchStateChange);
  // The draft-restore and fetch callbacks below read these between renders;
  // mirror the latest props here (before the layout effects that consume them)
  // so they never close over a stale render snapshot.
  useLayoutEffect(()=>{
    seedRef.current={initialSearch,initialSearchError};
    monitorRef.current=monitor;
    latestScope.current=requestScope;
    stateChange.current=onSearchStateChange;
  });
  const [results, setResults] = useState<ScreenFrameSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scope, setScope] = useState<"retained" | "selected" | "dates">(seed?.scope === "range" ? "dates" : "retained");
  const [sort, setSort] = useState<"ranked" | "newest">(seed?.sort ?? "ranked");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [complete, setComplete] = useState<boolean | null>(null);
  const [savedState,setSavedState] = useState<{key:string|null|undefined;items:SavedSearch[]}>({key:preferencesKey,items:[]});
  const saved = savedState.key === preferencesKey ? savedState.items : [];
  const setSaved = (items:SavedSearch[]) => setSavedState({key:preferencesKey,items});
  // Saved searches live in this browser for this server/user/device scope; a
  // new scope reloads them during render.
  const [prevSavedScope, setPrevSavedScope] = useState(preferencesKey);
  if (prevSavedScope !== preferencesKey) {
    setPrevSavedScope(preferencesKey);
    setSavedState({key:preferencesKey,items:preferencesKey ? readItems<unknown>(`${preferencesKey}:searches`).map(parseSavedSearch).filter((s):s is SavedSearch=>s!==null) : []});
  }
  const [groupSimilar, setGroupSimilar] = useState(true);
  // The last executed search: read by the status line and the save/refresh
  // actions, so it lives in state rather than a ref.
  const [frozen, setFrozen] = useState<{ query: string; opts: HistorySearchOpts } | null>(null);
  const busy = useRef(false);
  const seenCursors = useRef(new Set<string>());
  const generation = useRef(0);
  const invalidate = useCallback(() => {
    generation.current++;
    abort.current?.abort(); abort.current=null;
    busy.current = false;
    setFrozen(null);
    setCursor(null);
    setComplete(null);
    setResults(null);
    setError(null);
    setSearching(false);
  }, []);
  const lastVerified=useRef(preferencesKey ?? null);
  const lastServer=useRef(server);
  const baseScope=JSON.stringify([agentId,monitor,server]);
  const resetDraft=useCallback((restore:boolean)=>{
    const initial=seedRef.current;
    const restored=restore&&initial.initialSearch ? parseSavedSearch(initial.initialSearch) : null;
    setSearchMonitor(restored ? restored.monitor : monitorRef.current);
    setQuery(restored?.query ?? ""); setFilters(restored?.filters ?? {...EMPTY_CONTEXT_FILTERS});
    setSort(restored?.sort ?? "ranked"); setScope(restored?.scope === "range" ? "dates" : "retained");
    setRestoredBounds(restored?.scope === "range" ? {from:restored.from!,to:restored.to!} : null);
    setFrom("");setTo("");setLinkedError(restore ? initial.initialSearchError ?? null : null);
  },[]);
  useLayoutEffect(()=>{
    const restore=lastServer.current===server;lastServer.current=server;resetDraft(restore);
    if(lastMonitor.current!==monitor){setSearchMonitor(monitor);lastMonitor.current=monitor;}
  },[baseScope,server,monitor,resetDraft]);
  // A new request scope discards the previous round's results during render;
  // the layout effect below only cancels the in-flight work and replays the
  // draft seed, which must read the latest refs.
  const [prevRequestScope, setPrevRequestScope] = useState(requestScope);
  if (prevRequestScope !== requestScope) {
    setPrevRequestScope(requestScope);
    setFrozen(null);
    setCursor(null);
    setComplete(null);
    setResults(null);
    setError(null);
    setSearching(false);
  }
  useLayoutEffect(()=>{
    generation.current++;
    abort.current?.abort(); abort.current=null;
    busy.current = false;
    // Null is a temporary verification scope: mask results/saves, retain draft.
    // A different confirmed identity clears it without replaying an old URL seed.
    if(preferencesKey){if(lastVerified.current&&lastVerified.current!==preferencesKey)resetDraft(false);lastVerified.current=preferencesKey;}
    // Cancels asynchronous requests rather than referencing a DOM node.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return ()=>{generation.current++;abort.current?.abort();};
  },[requestScope,preferencesKey,resetDraft]);
  useEffect(() => onSessionExpired(()=>{invalidate();resetDraft(false);setSavedState({key:null,items:[]});}),[invalidate,resetDraft]);

  // Changes to the selected window invalidate its cursor, even while a page is pending.
  // The state resets derive during render; the effect below only cancels the
  // in-flight work.
  const selectedRangeKey = scope === "selected" ? `${range?.fromMs ?? "start"}:${range?.toMs ?? "end"}` : null;
  const [prevSelectedRangeKey, setPrevSelectedRangeKey] = useState(selectedRangeKey);
  if (prevSelectedRangeKey !== selectedRangeKey) {
    setPrevSelectedRangeKey(selectedRangeKey);
    if (selectedRangeKey !== null) {
      setFrozen(null);
      setCursor(null);
      setComplete(null);
      setResults(null);
      setError(null);
      setSearching(false);
    }
  }
  useEffect(() => {
    if (scope === "selected") {
      generation.current++;
      abort.current?.abort(); abort.current=null;
      busy.current = false;
    }
  }, [range?.fromMs, range?.toMs, scope]);
  const fetchPage = (snapshot: { query: string; opts: HistorySearchOpts }, next?: string) => {
    if (busy.current || preferencesKey===null) return;
    busy.current = true;
    const request = generation.current, context = requestScope;
    const controller=new AbortController(); abort.current=controller;
    const valid=()=>request===generation.current&&latestScope.current===context&&fleetServerScope()===server&&!controller.signal.aborted;
    setSearching(true); setError(null);
    api.historySearch(agentId, snapshot.query, { ...snapshot.opts, cursor: next },controller.signal)
      .then(res => {
        if (!valid()) return;
        const expected=parseRecallFilters({app:snapshot.opts.app,app_mode:snapshot.opts.app_mode,title:snapshot.opts.title,url_host:snapshot.opts.url_host,context:snapshot.opts.context});
        if (res.filters && JSON.stringify(parseRecallFilters(res.filters))!==JSON.stringify(expected)) throw new Error("The server returned different context filters. Clear filters and search again.");
        if (contextFiltersActive(expected) && !res.filters) throw new Error("This server does not support the selected context filters. Clear filters to use OCR search.");
        const continuation = res.next_cursor ?? null;
        if (res.has_more && !continuation) throw new Error("Search is incomplete but has no continuation cursor. Search again to retry.");
        if (continuation && seenCursors.current.has(continuation)) throw new Error("Search pagination did not advance. Search again to retry.");
        if (continuation) seenCursors.current.add(continuation);
        setResults(previous => valid() ? [...new Map([...(next ? previous ?? [] : []), ...res.results].map(hit => [hit.id, hit])).values()] : previous);
        setCursor(continuation); setComplete(continuation ? false : res.complete ?? null);
      })
      .catch(e => { if (valid()) setError(errorText(e)); })
      .finally(() => { if (valid()) { busy.current = false; setSearching(false); } });
  };
  let normalized: RecallContextFilters | null = null, filterError: string | null = null;
  try { normalized=parseRecallFilters(filters); } catch(e) {filterError=errorText(e);}
  const active=normalized ? contextFiltersActive(normalized) : false;
  const effectiveSort=query.trim() ? sort : "newest";
  const filterOpts=(value:RecallContextFilters):Partial<RecallContextFilters>=>contextFiltersActive(value) ? {...value} : {};
  const clearFilters=()=>{invalidate();setFilters({...EMPTY_CONTEXT_FILTERS});setLinkedError(null);};
  const runSearch = (savedSearch?: SavedSearch) => {
    const validSaved=savedSearch ? parseSavedSearch(savedSearch) : null;
    const q=(validSaved?.query ?? query).trim();
    const selected=validSaved?.filters ?? normalized;
    if (!selected || new TextEncoder().encode(q).length>4096) {invalidate();setError(filterError ?? "OCR query exceeds 4096 UTF-8 bytes.");return;}
    if (!q && !contextFiltersActive(selected)) return;
    let opts: HistorySearchOpts = {scope:validSaved?.scope ?? (scope==="retained" ? "retained" : "range"),sort:q ? validSaved?.sort ?? sort : "newest",monitor:validSaved ? validSaved.monitor : searchMonitor,limit:100,...filterOpts(selected)};
    if (validSaved?.scope === "range") opts={...opts,from:validSaved.from,to:validSaved.to};
    else if (!validSaved && scope!=="retained") {
      const start=scope==="selected" ? range?.fromMs : restoredBounds ? Date.parse(restoredBounds.from) : deviceTime(from,timezone);
      const end=scope==="selected" ? range?.toMs : restoredBounds ? Date.parse(restoredBounds.to) : deviceTime(to,timezone);
      if(start==null||end==null||start>=end){invalidate();setError("Enter a valid start and later end in the device timezone. Ambiguous or skipped DST times are invalid.");return;}
      opts={...opts,from:new Date(start).toISOString(),to:new Date(end).toISOString()};
    }
    if (validSaved) {setSearchMonitor(validSaved.monitor);setQuery(validSaved.query);setFilters(validSaved.filters!);setSort(validSaved.sort);setScope(validSaved.scope==="range" ? "dates" : "retained");setRestoredBounds(validSaved.scope==="range" ? {from:validSaved.from!,to:validSaved.to!} : null);setFrom("");setTo("");}
    invalidate();seenCursors.current.clear();setLinkedError(null);
    const snapshot={query:q,opts:Object.freeze({...opts})};setFrozen(snapshot);fetchPage(snapshot);
  };
  useEffect(()=>{
    let restored:SavedSearch|null=null;
    if(normalized && (query.trim()||contextFiltersActive(normalized))) {
      if(scope==="retained") restored={query:query.trim(),scope:"retained",sort:effectiveSort,monitor:searchMonitor,filters:normalized};
      else {
        const start=scope==="selected" ? range?.fromMs : restoredBounds ? Date.parse(restoredBounds.from) : deviceTime(from,timezone);
        const end=scope==="selected" ? range?.toMs : restoredBounds ? Date.parse(restoredBounds.to) : deviceTime(to,timezone);
        if(start!=null&&end!=null&&start<end)restored={query:query.trim(),scope:"range",sort:effectiveSort,monitor:searchMonitor,from:new Date(start).toISOString(),to:new Date(end).toISOString(),filters:normalized};
      }
    }
    stateChange.current?.(restored);
    // Depend on scalar draft identity rather than a newly normalized object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[query,filters,scope,effectiveSort,searchMonitor,from,to,timezone,range?.fromMs,range?.toMs,restoredBounds]);
  const saveSearch = () => {
    if (!preferencesKey || !frozen) return;
    const { query: q, opts } = frozen;
    const item: SavedSearch = { query: q, scope: opts.scope ?? "retained", sort: opts.sort ?? "ranked", monitor: opts.monitor ?? null, from: opts.from, to: opts.to, filters:parseRecallFilters({app:opts.app,app_mode:opts.app_mode,title:opts.title,url_host:opts.url_host,context:opts.context}) };
    const next = [item, ...saved.filter(s => JSON.stringify(s) !== JSON.stringify(item))].slice(0, 100);
    if (writeItems(`${preferencesKey}:searches`, next)) setSaved(next);
    else setError("Browser storage is unavailable; search was not saved.");
  };

  const renderResult = (r: ScreenFrameSearchResult) => (
    <button
                key={`${agentId}:${r.id}`}
                onClick={() => onSeek(r.captured_at, r.monitor,r.id)}
                className="flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {/* A thumbnail makes a hit identifiable at a glance; a text snippet
                    alone left you clicking through results to recognize the screen. */}
                <RecallImage
                  src={api.historyBlobUrl(agentId, r.id, RESULT_W)}
                  loading="lazy"
                  style={{
                    flex: "0 0 auto",
                    width: "clamp(48px, 20vw, 96px)",
                    aspectRatio: "16 / 9",
                    objectFit: "cover",
                    borderRadius: 6,
                    border: "1px solid var(--ui-border)",
                  }}
                />
                <span className="flex min-w-0 flex-col gap-[3px]">
                  <span className="font-mono text-[11.5px] text-muted-foreground">
                    {shortDateIn(timezone, new Date(r.captured_at).getTime())} ·{" "}
                    {timeIn(timezone, r.captured_at)}
                  </span>
                  <span className="text-[13px] [overflow-wrap:anywhere]">{renderSnippet(r.snippet)}</span>
                  <RecallCaptureContext context={r.context} compact/>
                </span>
              </button>
  );

  return (
    <div className="recall-search rounded-xl bg-card p-5">
      {preferencesKey===null&&<p role="status" className="mb-2 text-sm text-muted-foreground">Verifying your signed-in account. Search results and local saved searches are hidden.</p>}
      <p className="text-sm text-muted-foreground">Search recorded screen text (OCR) on {searchMonitor == null ? "all displays" : `Display ${searchMonitor + 1}`}.</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
        <Input
          type="search"
          value={query}
          aria-label="Search screen text"
          onChange={(e) => { invalidate(); setQuery(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") runSearch();
          }}
          placeholder="Search all screen text (OCR)…"
          className="h-9 max-w-115 min-w-0 flex-[1_1_180px]"
        />
        <Button onClick={() => runSearch()} disabled={preferencesKey===null || Boolean(filterError) || query.trim()==="" && !active}>
          Search
        </Button>
        {(query || active || results !== null || searching || error || linkedError) && (
          <Button
            variant="link"
            onClick={() => {
              invalidate();
              setQuery("");setFilters({...EMPTY_CONTEXT_FILTERS});setLinkedError(null);
            }}
          >
            Clear
          </Button>
        )}
      </div>

      <div className="recall-retrieval-fields">
        <Label>Search scope <select aria-label="Search scope" value={scope} onChange={e => { invalidate(); setScope(e.target.value as typeof scope); }} className="h-9 rounded-lg bg-muted/70 px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <option value="retained">All retained history</option><option value="selected" disabled={!range}>Selected playback range</option><option value="dates">Custom dates</option>
        </select></Label>
        <Label>Order <select aria-label="Search order" value={effectiveSort} disabled={!query.trim()} onChange={e => { invalidate(); setSort(e.target.value as typeof sort); }} className="h-9 rounded-lg bg-muted/70 px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
          <option value="ranked">Relevance</option><option value="newest">Newest first</option>
        </select></Label>
        {scope === "dates" && <><Label>Search from <Input type="datetime-local" value={from} onChange={e => { invalidate(); setFrom(e.target.value);setRestoredBounds(null); }} className="h-9" /></Label><Label>Search to <Input type="datetime-local" value={to} onChange={e => { invalidate(); setTo(e.target.value);setRestoredBounds(null); }} className="h-9" /></Label><span className="text-xs text-muted-foreground">Device timezone: {timezone ?? "unavailable — date search disabled"}</span></>}
      </div>
      <div className="recall-retrieval-fields recall-retrieval-actions">
        <Label className="recall-inline-check"><input type="checkbox" checked={groupSimilar} onChange={e => setGroupSimilar(e.target.checked)} className="size-4.5 accent-primary" /> Group similar captures</Label>
        <Button variant="outline" onClick={saveSearch} disabled={!preferencesKey || !frozen || searching}>Save search</Button>
      </div>
      <details className="recall-context-filters">
        <summary>Foreground context filters{active ? " (active)" : ""}</summary>
        <p className="text-sm text-muted-foreground">Foreground observed around capture. It may differ from the apps visible on this display.</p>
        <div className="recall-retrieval-fields">
          <Label>Foreground app around capture <Input aria-label="Foreground app around capture" value={filters.app ?? ""} maxLength={256} placeholder="editor.exe" onChange={e=>{invalidate();setFilters({...filters,app:e.target.value,app_mode:e.target.value.trim() ? filters.app_mode : "exact"});}} className="h-9" /></Label>
          <Label>App match <select aria-label="App match" value={filters.app_mode} disabled={!filters.app?.trim()} onChange={e=>{invalidate();setFilters({...filters,app_mode:e.target.value as RecallContextFilters["app_mode"]});}} className="h-9 rounded-lg bg-muted/70 px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
            <option value="exact">Exact identity</option><option value="prefix">Literal prefix</option>
          </select></Label>
          <Label>Foreground title contains <Input aria-label="Foreground title contains" value={filters.title ?? ""} maxLength={1024} onChange={e=>{invalidate();setFilters({...filters,title:e.target.value});}} className="h-9" /></Label>
          <Label>Exact host <Input aria-label="Exact host" value={filters.url_host ?? ""} maxLength={253} placeholder="docs.example.com" onChange={e=>{invalidate();setFilters({...filters,url_host:e.target.value});}} className="h-9" /></Label>
          <Label>Capture context <select aria-label="Capture context" value={filters.context} onChange={e=>{invalidate();setFilters({...filters,context:e.target.value as RecallContextFilters["context"]});}} className="h-9 rounded-lg bg-muted/70 px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <option value="all">All contexts (OCR default)</option><option value="known">Known observed context</option><option value="unknown">Unknown / older / unavailable</option>
          </select></Label>
          <Button variant="outline" onClick={clearFilters} disabled={!active&&!filterError&&!linkedError}>Clear filters</Button>
        </div>
        <p className="text-sm text-muted-foreground">Use the app identity as recorded, including .exe. Title matching is literal and ignores ASCII letter case. Exact hosts exclude subdomains. Current agents do not record site context; this filter applies only to recordings that include a host.</p>
        {!query.trim()&&active&&<p role="status" className="text-sm text-muted-foreground">Context-only search shows newest captures without OCR relevance.</p>}
        {restoredBounds&&<p className="text-sm text-muted-foreground">Restored exact range: {restoredBounds.from} – {restoredBounds.to}</p>}
      </details>
      {(filterError||linkedError)&&<p role="alert" className="mt-2 text-sm text-destructive"> {filterError||linkedError} <Button variant="outline" size="sm" onClick={clearFilters}>Clear filters</Button></p>}
      {saved.length > 0 && <div aria-label="Saved searches" className="mt-2 flex flex-col gap-2">{saved.map((item, i) => <div key={i} className="recall-retrieval-fields"><Button variant="outline" className="h-auto min-w-0 justify-start whitespace-normal py-2 text-left break-words" onClick={() => { setQuery(item.query); runSearch(item); }}>Run saved: {item.query || "Context only"} · {item.filters?.app ? `app ${item.filters.app} (${item.filters.app_mode}) · ` : ""}{item.filters?.title ? `title ${item.filters.title} · ` : ""}{item.filters?.url_host ? `host ${item.filters.url_host} · ` : ""}{item.filters?.context && item.filters.context!=="all" ? `${item.filters.context} context · ` : ""}{item.sort} · {item.scope}{item.from ? ` · ${item.from} – ${item.to}` : ""} · {item.monitor == null ? "all displays" : `display ${item.monitor + 1}`}</Button><Button variant="ghost" onClick={() => { const next = saved.filter((_, j) => i !== j); if (preferencesKey && writeItems(`${preferencesKey}:searches`, next)) setSaved(next); else setError("Could not remove saved search."); }}>Remove</Button></div>)}</div>}
      {results !== null && <p role="status" className="mt-2 text-sm text-muted-foreground">{results.length} matches loaded for “{frozen?.query}” · {frozen?.opts.sort === "newest" ? "Newest first" : "Relevance"} · {frozen?.opts.scope === "retained" ? "All retained history" : `${frozen?.opts.from} – ${frozen?.opts.to}`}. {cursor ? "More matches available." : complete === true ? "Search complete." : complete === false ? "Search incomplete." : "Completeness unknown."} <Button variant="link" size="sm" onClick={()=>runSearch()} disabled={searching||Boolean(filterError)}>Refresh search</Button></p>}
      {cursor && <Button variant="outline" onClick={() => { if (frozen) fetchPage(frozen, cursor); }} disabled={searching}>Load more</Button>}
      {error && (
        <p role="alert" className="pt-1 text-sm text-destructive">
          {error}
        </p>
      )}

      {results !== null && (
        <div className="mt-2.5 max-h-80 divide-y divide-foreground/[0.06] overflow-y-auto rounded-xl bg-muted/50">
          {results.length === 0 ? (
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
              No retained screens matched this text and context in this scope. Older recordings may have expired.
              <Button variant="outline" size="sm" onClick={clearFilters}>Clear filters</Button><Button variant="outline" size="sm" onClick={()=>runSearch()} disabled={searching||Boolean(filterError)}>Refresh search</Button>
            </div>
          ) : (
            (groupSimilar ? groupSearchHits(results) : results.map(hit => [hit])).map(group => group.length === 1 ? renderResult(group[0]) : (
              <details key={`group:${agentId}:${group[0].id}`} className="recall-search-group">
                <summary>{group.length} similar captures · Display {group[0].monitor + 1} · {shortDateIn(timezone, Date.parse(group[0].captured_at))} {timeIn(timezone, group[0].captured_at)} — expand to choose a recording</summary>
                {group.map(renderResult)}
              </details>
            ))
          )}
        </div>
      )}
    </div>
  );
}
