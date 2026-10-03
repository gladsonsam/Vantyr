import { RecallImage } from "./RecallImage";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button } from "../ui/console";
import { api, errorText } from "../../lib/api";
import type { ScreenFrameSearchResult } from "../../lib/types";
import { deviceTime, readItems, writeItems, type SavedSearch } from "./recallRetrieval";
import type { HistoryRangeOpts } from "../../lib/api";
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
  onSeek: (iso: string, monitor?: number | null) => void;
  timezone: string | null;
  range?: { fromMs: number; toMs: number };
  preferencesKey?: string | null;
}

/** OCR full-text search over an agent's captured screens, with frame previews. */
export function RecallSearch({ agentId, monitor, onSeek, timezone, range, preferencesKey }: RecallSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ScreenFrameSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scope, setScope] = useState<"retained" | "selected" | "dates">("retained");
  const [sort, setSort] = useState<"ranked" | "newest">("ranked");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [complete, setComplete] = useState<boolean | null>(null);
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const frozen = useRef<{ query: string; opts: HistoryRangeOpts } | null>(null);
  const busy = useRef(false);
  const seenCursors = useRef(new Set<string>());
  useEffect(() => { setSaved(preferencesKey ? readItems<SavedSearch>(`${preferencesKey}:searches`).filter(s => s != null && typeof s.query === "string" && ["range", "retained"].includes(s.scope) && ["ranked", "newest"].includes(s.sort) && (s.monitor == null || Number.isSafeInteger(s.monitor)) && (s.scope === "retained" || (typeof s.from === "string" && typeof s.to === "string" && Date.parse(s.from) < Date.parse(s.to)))) : []); }, [preferencesKey]);
  const generation = useRef(0);
  const invalidate = useCallback(() => {
    generation.current++;
    busy.current = false;
    frozen.current = null;
    setCursor(null);
    setComplete(null);
    setResults(null);
    setError(null);
    setSearching(false);
  }, []);
  useEffect(() => {
    invalidate();
    setQuery("");
    // A request generation is intentionally invalidated on scope cleanup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { generation.current++; };
  }, [agentId, monitor, invalidate]);

  // Changes to the selected window invalidate its cursor, even while a page is pending.
  useEffect(() => { if (scope === "selected") invalidate(); }, [range?.fromMs, range?.toMs, scope, invalidate]);
  const fetchPage = (snapshot: { query: string; opts: HistoryRangeOpts }, next?: string) => {
    if (busy.current) return;
    busy.current = true;
    const request = generation.current;
    setSearching(true); setError(null);
    api.historySearch(agentId, snapshot.query, { ...snapshot.opts, cursor: next })
      .then(res => {
        if (request !== generation.current) return;
        const continuation = res.next_cursor ?? null;
        if (res.has_more && !continuation) throw new Error("Search is incomplete but has no continuation cursor. Search again to retry.");
        if (continuation && seenCursors.current.has(continuation)) throw new Error("Search pagination did not advance. Search again to retry.");
        if (continuation) seenCursors.current.add(continuation);
        setResults(previous => [...new Map([...(next ? previous ?? [] : []), ...res.results].map(hit => [hit.id, hit])).values()]);
        setCursor(continuation); setComplete(continuation ? false : res.complete ?? null);
      })
      .catch(e => { if (request === generation.current) setError(errorText(e)); })
      .finally(() => { if (request === generation.current) { busy.current = false; setSearching(false); } });
  };
  const runSearch = (savedSearch?: SavedSearch) => {
    const q = (savedSearch?.query ?? query).trim();
    if (!q) return;
    let opts: HistoryRangeOpts = savedSearch ? { ...savedSearch, limit: 100 } : { scope: scope === "retained" ? "retained" : "range", sort, monitor, limit: 100 };
    if (!savedSearch && scope !== "retained") {
      const start = scope === "selected" ? range?.fromMs : deviceTime(from, timezone);
      const end = scope === "selected" ? range?.toMs : deviceTime(to, timezone);
      if (start == null || end == null || start >= end) { invalidate(); setError("Enter a valid start and later end in the device timezone. Ambiguous or skipped DST times are invalid."); return; }
      opts = { ...opts, from: new Date(start).toISOString(), to: new Date(end).toISOString() };
    }
    invalidate(); seenCursors.current.clear();
    frozen.current = { query: q, opts };
    fetchPage(frozen.current);
  };
  const saveSearch = () => {
    if (!preferencesKey || !frozen.current) return;
    const { query: q, opts } = frozen.current;
    const item: SavedSearch = { query: q, scope: opts.scope ?? "retained", sort: opts.sort ?? "ranked", monitor: opts.monitor ?? null, from: opts.from, to: opts.to };
    const next = [item, ...saved.filter(s => JSON.stringify(s) !== JSON.stringify(item))].slice(0, 100);
    if (writeItems(`${preferencesKey}:searches`, next)) setSaved(next);
    else setError("Browser storage is unavailable; search was not saved.");
  };

  return (
    <div className="recall-search">
      <p>Search recorded screen text (OCR) on {monitor == null ? "all displays" : `Display ${monitor + 1}`}.</p>
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
        <Button onClick={() => runSearch()} loading={searching} disabled={query.trim() === ""}>
          Search
        </Button>
        {(query || results !== null || searching || error) && (
          <Button
            variant="link"
            onClick={() => {
              invalidate();
              setQuery("");
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
        <label>Order <select aria-label="Search order" value={sort} onChange={e => { invalidate(); setSort(e.target.value as typeof sort); }}><option value="ranked">Relevance</option><option value="newest">Newest first</option></select></label>
        {scope === "dates" && <><label>Search from <input type="datetime-local" value={from} onChange={e => { invalidate(); setFrom(e.target.value); }} /></label><label>Search to <input type="datetime-local" value={to} onChange={e => { invalidate(); setTo(e.target.value); }} /></label><span>Device timezone: {timezone ?? "unavailable — date search disabled"}</span></>}
        <Button onClick={saveSearch} disabled={!preferencesKey || !frozen.current || searching}>Save search</Button>
      </div>
      {saved.length > 0 && <div aria-label="Saved searches">{saved.map((item, i) => <div key={i} className="recall-retrieval-fields"><Button onClick={() => { setQuery(item.query); runSearch(item); }}>Run saved: {item.query} · {item.sort} · {item.scope}{item.from ? ` · ${item.from} – ${item.to}` : ""} · {item.monitor == null ? "all displays" : `display ${item.monitor + 1}`}</Button><Button onClick={() => { const next = saved.filter((_, j) => i !== j); if (preferencesKey && writeItems(`${preferencesKey}:searches`, next)) setSaved(next); else setError("Could not remove saved search."); }}>Remove</Button></div>)}</div>}
      {results !== null && <p role="status">{results.length} matches loaded for “{frozen.current?.query}” · {frozen.current?.opts.sort === "newest" ? "Newest first" : "Relevance"} · {frozen.current?.opts.scope === "retained" ? "All retained history" : `${frozen.current?.opts.from} – ${frozen.current?.opts.to}`}. {cursor ? "More matches available." : complete === true ? "Search complete." : complete === false ? "Search incomplete." : "Server does not report completeness."}</p>}
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
              No retained screens matched that text in this scope. Older recordings may have expired.
            </Box>
          ) : (
            results.map((r) => (
              <button
                key={`${agentId}:${r.id}`}
                onClick={() => onSeek(r.captured_at, r.monitor)}
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
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
