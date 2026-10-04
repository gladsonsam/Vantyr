import { RecallCaptureContext } from "./RecallCaptureContext";
import { contextFiltersActive, EMPTY_CONTEXT_FILTERS, parseRecallFilters, type RecallContextFilters } from "../../lib/recallContext";
import { fleetServerScope } from "../../lib/fleetPreferences";
import { RecallImage } from "./RecallImage";
import { groupSearchHits } from "./recallSearchGroups";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Box, Button } from "../ui/console";
import { api, errorText } from "../../lib/api";
import type { ScreenFrameSearchResult } from "../../lib/types";
import { deviceTime, parseSavedSearch, readItems, writeItems, type SavedSearch } from "./recallRetrieval";
import type { HistorySearchOpts } from "../../lib/api";
import { shortDateIn, timeIn } from "./recallFormat";

/** Thumbnail width per result row. */
const RESULT_W = 160;

/** Render a `ts_headline` snippet, bolding the `[[[…]]]`-delimited matches (no HTML). */
function renderSnippet(snippet: string): ReactNode[] {
  return snippet.split(/(\[\[\[.*?\]\]\])/g).map((part, i) => {
    const m = /^\[\[\[(.*?)\]\]\]$/.exec(part);
    return m ? (
      <strong key={i} style={{ color: "var(--gr)" }}>
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
  const seedRef=useRef({initialSearch,initialSearchError});seedRef.current={initialSearch,initialSearchError};
  const seed = initialSearch ? parseSavedSearch(initialSearch) : null;
  const monitorRef=useRef(monitor);monitorRef.current=monitor;
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
  const latestScope = useRef(requestScope); latestScope.current = requestScope;
  const abort = useRef<AbortController|null>(null);
  const stateChange = useRef(onSearchStateChange); stateChange.current = onSearchStateChange;
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
  const [groupSimilar, setGroupSimilar] = useState(true);
  const frozen = useRef<{ query: string; opts: HistorySearchOpts } | null>(null);
  const busy = useRef(false);
  const seenCursors = useRef(new Set<string>());
  useEffect(() => {
    const items=preferencesKey ? readItems<unknown>(`${preferencesKey}:searches`).map(parseSavedSearch).filter((s):s is SavedSearch=>s!==null) : [];
    setSavedState({key:preferencesKey,items});
  },[preferencesKey]);
  const generation = useRef(0);
  const invalidate = useCallback(() => {
    generation.current++;
    abort.current?.abort(); abort.current=null;
    busy.current = false;
    frozen.current = null;
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
  useLayoutEffect(()=>{
    invalidate();
    // Null is a temporary verification scope: mask results/saves, retain draft.
    // A different confirmed identity clears it without replaying an old URL seed.
    if(preferencesKey){if(lastVerified.current&&lastVerified.current!==preferencesKey)resetDraft(false);lastVerified.current=preferencesKey;}
    // Cancels asynchronous requests rather than referencing a DOM node.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return ()=>{generation.current++;abort.current?.abort();};
  },[requestScope,preferencesKey,invalidate,resetDraft]);
  useEffect(() => {
    const expire=()=>{invalidate();resetDraft(false);setSavedState({key:null,items:[]});};
    window.addEventListener("vantyr-session-expired",expire);
    return ()=>window.removeEventListener("vantyr-session-expired",expire);
  },[invalidate,resetDraft]);

  // Changes to the selected window invalidate its cursor, even while a page is pending.
  useEffect(() => { if (scope === "selected") invalidate(); }, [range?.fromMs, range?.toMs, scope, invalidate]);
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
    frozen.current={query:q,opts:Object.freeze({...opts})};fetchPage(frozen.current);
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
    if (!preferencesKey || !frozen.current) return;
    const { query: q, opts } = frozen.current;
    const item: SavedSearch = { query: q, scope: opts.scope ?? "retained", sort: opts.sort ?? "ranked", monitor: opts.monitor ?? null, from: opts.from, to: opts.to, filters:parseRecallFilters({app:opts.app,app_mode:opts.app_mode,title:opts.title,url_host:opts.url_host,context:opts.context}) };
    const next = [item, ...saved.filter(s => JSON.stringify(s) !== JSON.stringify(item))].slice(0, 100);
    if (writeItems(`${preferencesKey}:searches`, next)) setSaved(next);
    else setError("Browser storage is unavailable; search was not saved.");
  };

  const renderResult = (r: ScreenFrameSearchResult) => (
    <button
                key={`${agentId}:${r.id}`}
                onClick={() => onSeek(r.captured_at, r.monitor,r.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 12px",
                  background: "transparent",
                  border: "none",
                  borderBottom: "1px solid var(--line)",
                  color: "var(--tx)",
                  cursor: "pointer",
                }}
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
                    border: "1px solid var(--line)",
                  }}
                />
                <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                  <span
                    style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--tx-2)" }}
                  >
                    {shortDateIn(timezone, new Date(r.captured_at).getTime())} ·{" "}
                    {timeIn(timezone, r.captured_at)}
                  </span>
                  <span style={{ fontSize: 13, overflowWrap: "anywhere" }}>{renderSnippet(r.snippet)}</span>
                  <RecallCaptureContext context={r.context} compact/>
                </span>
              </button>
  );

  return (
    <div className="recall-search">
      {preferencesKey===null&&<p role="status">Verifying your signed-in account. Search results and local saved searches are hidden.</p>}
      <p>Search recorded screen text (OCR) on {searchMonitor == null ? "all displays" : `Display ${searchMonitor + 1}`}.</p>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="search"
          value={query}
          aria-label="Search screen text"
          onChange={(e) => { invalidate(); setQuery(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") runSearch();
          }}
          placeholder="Search all screen text (OCR)…"
          style={{
            flex: "1 1 180px",
            minWidth: 0,
            minHeight: 44,
            maxWidth: 460,
            padding: "9px 12px",
            borderRadius: 10,
            border: "1px solid var(--line)",
            background: "var(--card)",
            color: "var(--tx)",
            fontFamily: "var(--font)",
            fontSize: 13.5,
          }}
        />
        <Button onClick={() => runSearch()} loading={searching} disabled={preferencesKey===null || Boolean(filterError) || query.trim()==="" && !active}>
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
        <label>Search scope <select aria-label="Search scope" value={scope} onChange={e => { invalidate(); setScope(e.target.value as typeof scope); }}>
          <option value="retained">All retained history</option><option value="selected" disabled={!range}>Selected playback range</option><option value="dates">Custom dates</option>
        </select></label>
        <label>Order <select aria-label="Search order" value={effectiveSort} disabled={!query.trim()} onChange={e => { invalidate(); setSort(e.target.value as typeof sort); }}><option value="ranked">Relevance</option><option value="newest">Newest first</option></select></label>
        {scope === "dates" && <><label>Search from <input type="datetime-local" value={from} onChange={e => { invalidate(); setFrom(e.target.value);setRestoredBounds(null); }} /></label><label>Search to <input type="datetime-local" value={to} onChange={e => { invalidate(); setTo(e.target.value);setRestoredBounds(null); }} /></label><span>Device timezone: {timezone ?? "unavailable — date search disabled"}</span></>}
        <label className="recall-inline-check"><input type="checkbox" checked={groupSimilar} onChange={e => setGroupSimilar(e.target.checked)} /> Group similar captures</label>
        <Button onClick={saveSearch} disabled={!preferencesKey || !frozen.current || searching}>Save search</Button>
      </div>
      <details className="recall-context-filters">
        <summary>Foreground context filters{active ? " (active)" : ""}</summary>
        <p>Foreground observed around capture. It may differ from the apps visible on this display.</p>
        <div className="recall-retrieval-fields">
          <label>Foreground app around capture <input aria-label="Foreground app around capture" value={filters.app ?? ""} maxLength={256} placeholder="editor.exe" onChange={e=>{invalidate();setFilters({...filters,app:e.target.value,app_mode:e.target.value.trim() ? filters.app_mode : "exact"});}}/></label>
          <label>App match <select aria-label="App match" value={filters.app_mode} disabled={!filters.app?.trim()} onChange={e=>{invalidate();setFilters({...filters,app_mode:e.target.value as RecallContextFilters["app_mode"]});}}><option value="exact">Exact identity</option><option value="prefix">Literal prefix</option></select></label>
          <label>Foreground title contains <input aria-label="Foreground title contains" value={filters.title ?? ""} maxLength={1024} onChange={e=>{invalidate();setFilters({...filters,title:e.target.value});}}/></label>
          <label>Exact host <input aria-label="Exact host" value={filters.url_host ?? ""} maxLength={253} placeholder="docs.example.com" onChange={e=>{invalidate();setFilters({...filters,url_host:e.target.value});}}/></label>
          <label>Capture context <select aria-label="Capture context" value={filters.context} onChange={e=>{invalidate();setFilters({...filters,context:e.target.value as RecallContextFilters["context"]});}}><option value="all">All contexts (OCR default)</option><option value="known">Known observed context</option><option value="unknown">Unknown / older / unavailable</option></select></label>
          <Button onClick={clearFilters} disabled={!active&&!filterError&&!linkedError}>Clear filters</Button>
        </div>
        <p>Use the app identity as recorded, including .exe. Title matching is literal and ignores ASCII letter case. Exact hosts exclude subdomains. Current agents do not record site context; this filter applies only to recordings that include a host.</p>
        {!query.trim()&&active&&<p role="status">Context-only search shows newest captures without OCR relevance.</p>}
        {restoredBounds&&<p>Restored exact range: {restoredBounds.from} – {restoredBounds.to}</p>}
      </details>
      {(filterError||linkedError)&&<p role="alert">{filterError||linkedError} <Button onClick={clearFilters}>Clear filters</Button></p>}
      {saved.length > 0 && <div aria-label="Saved searches">{saved.map((item, i) => <div key={i} className="recall-retrieval-fields"><Button onClick={() => { setQuery(item.query); runSearch(item); }}>Run saved: {item.query || "Context only"} · {item.filters?.app ? `app ${item.filters.app} (${item.filters.app_mode}) · ` : ""}{item.filters?.title ? `title ${item.filters.title} · ` : ""}{item.filters?.url_host ? `host ${item.filters.url_host} · ` : ""}{item.filters?.context && item.filters.context!=="all" ? `${item.filters.context} context · ` : ""}{item.sort} · {item.scope}{item.from ? ` · ${item.from} – ${item.to}` : ""} · {item.monitor == null ? "all displays" : `display ${item.monitor + 1}`}</Button><Button onClick={() => { const next = saved.filter((_, j) => i !== j); if (preferencesKey && writeItems(`${preferencesKey}:searches`, next)) setSaved(next); else setError("Could not remove saved search."); }}>Remove</Button></div>)}</div>}
      {results !== null && <p role="status">{results.length} matches loaded for “{frozen.current?.query}” · {frozen.current?.opts.sort === "newest" ? "Newest first" : "Relevance"} · {frozen.current?.opts.scope === "retained" ? "All retained history" : `${frozen.current?.opts.from} – ${frozen.current?.opts.to}`}. {cursor ? "More matches available." : complete === true ? "Search complete for matching retained rows at this request." : complete === false ? "Search incomplete." : "Server does not report completeness."} Paging keeps these filters and dates. New uploads and retention can change later pages. <Button onClick={()=>runSearch()} disabled={searching||Boolean(filterError)}>Refresh search</Button></p>}
      {cursor && <Button onClick={() => { if (frozen.current) fetchPage(frozen.current, cursor); }} disabled={searching}>Load more</Button>}
      {error && (
        <Box color="text-status-error" fontSize="body-s" padding={{ top: "xs" }}>
          {error}
        </Box>
      )}

      {results !== null && (
        <div
          style={{
            marginTop: 10,
            background: "var(--card)",
            border: "1px solid var(--line)",
            borderRadius: 12,
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          {results.length === 0 ? (
            <Box padding={{ vertical: "m", horizontal: "l" }} color="text-body-secondary">
              No retained screens matched this text and context in this scope. Older recordings may have expired.
              <Button onClick={clearFilters}>Clear filters</Button><Button onClick={()=>runSearch()} disabled={searching||Boolean(filterError)}>Refresh search</Button>
            </Box>
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
