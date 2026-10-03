import { RecallImage } from "./RecallImage";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button } from "../ui/console";
import { api, errorText } from "../../lib/api";
import type { ScreenFrameSearchResult } from "../../lib/types";
import { shortDateIn, timeIn } from "./recallFormat";

/** Thumbnail width per result row. */
const RESULT_W = 160;

/**
 * How far back a search reaches. Far wider than any plausible retention setting;
 * the server clamps the result count.
 *
 * Deliberately not the loaded window: scoping search to what's on screen made
 * "when did I last see X?" unanswerable unless you had already guessed the right
 * range. Hits outside the window are handled by the caller's seek, which widens the
 * window around the result first.
 */
const SEARCH_SPAN_MS = 365 * 24 * 3600 * 1000;

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
  onSeek: (iso: string) => void;
  timezone: string | null;
}

/** OCR full-text search over an agent's captured screens, with frame previews. */
export function RecallSearch({ agentId, monitor, onSeek, timezone }: RecallSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ScreenFrameSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generation = useRef(0);
  const invalidate = useCallback(() => {
    generation.current++;
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

  const runSearch = useCallback(() => {
    const q = query.trim();
    if (!q) return;
    const request = ++generation.current;
    setResults(null);
    setSearching(true);
    setError(null);
    const to = new Date();
    const from = new Date(to.getTime() - SEARCH_SPAN_MS);
    api
      .historySearch(agentId, q, {
        from: from.toISOString(),
        to: to.toISOString(),
        monitor,
        limit: 100,
      })
      .then((res) => { if (request === generation.current) setResults(res.results); })
      .catch((e) => { if (request === generation.current) setError(errorText(e)); })
      .finally(() => { if (request === generation.current) setSearching(false); });
  }, [agentId, query, monitor]);

  return (
    <div className="recall-search">
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
        <Button onClick={runSearch} loading={searching} disabled={query.trim() === ""}>
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
              No screens matched that text.
            </Box>
          ) : (
            results.map((r) => (
              <button
                key={`${agentId}:${r.id}`}
                onClick={() => onSeek(r.captured_at)}
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
