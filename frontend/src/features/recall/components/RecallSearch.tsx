import { RecallCaptureContext } from "./RecallCaptureContext";
import {
  contextFiltersActive,
  EMPTY_CONTEXT_FILTERS,
  parseRecallFilters,
} from "@/features/recall/lib/recallContext";
import type { RecallContextFilters } from "@/api/types";
import { fleetServerScope } from "@/hooks/useVerifiedUser";
import { RecallImage } from "./RecallImage";
import { groupSearchHits } from "@/features/recall/lib/recallSearchGroups";
import type { ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@vantyr/ui/components/button";
import { Input } from "@vantyr/ui/components/input";
import { Label } from "@vantyr/ui/components/label";
import { api, errorText } from "@/api";
import type { ScreenFrameSearchResult } from "@/api/types";
import {
  deviceTime,
  parseSavedSearch,
  readItems,
  writeItems,
  type SavedSearch,
} from "@/features/recall/lib/recallRetrieval";
import type { HistorySearchOpts } from "@/api";
import { shortDateIn, timeIn } from "@/features/recall/lib/recallFormat";
import { onSessionExpired } from "@/api/sessionExpiry";
import { HelpTip } from "@/components/common/HelpTip";

/** Thumbnail width per result row. */
const RESULT_W = 160;

/** Render a `ts_headline` snippet, bolding the `[[[…]]]`-delimited matches (no HTML). */
function renderSnippet(snippet: string): ReactNode[] {
  let offset = 0;
  return snippet.split(/(\[\[\[.*?\]\]\])/g).map((part) => {
    const key = `${offset}:${part}`;
    offset += part.length;
    const m = /^\[\[\[(.*?)\]\]\]$/.exec(part);
    return m ? (
      <strong key={key} className="text-success">
        {m[1]}
      </strong>
    ) : (
      <span key={key}>{part}</span>
    );
  });
}

interface RecallSearchProps {
  agentId: string;
  /** Restrict hits to the display being replayed, matching what the player shows. */
  monitor: number | null;
  onSeek: (iso: string, monitor?: number | null, frameId?: number) => void;
  timezone: string | null;
  range?: { fromMs: number; toMs: number };
  preferencesKey?: string | null;
  initialSearch?: SavedSearch | null;
  initialSearchError?: string | null;
  onSearchStateChange?: (search: SavedSearch | null) => void;
}

/** Each device/display/server gets an independent draft and request lifecycle. */
export function RecallSearch(props: RecallSearchProps) {
  const server = useSyncExternalStore(
    subscribeServerScope,
    fleetServerScope,
    emptyServerScope,
  );
  const key = JSON.stringify([props.agentId, props.monitor, server]);
  // Each session receives one seed. A display change keeps the latest draft but
  // targets the new display; a server change never replays another server's seed.
  const [session, setSession] = useState(() => ({
    key,
    server,
    seed: props.initialSearch,
    error: props.initialSearchError,
  }));
  if (session.key !== key) {
    const seed =
      session.server === server && props.initialSearch
        ? { ...props.initialSearch, monitor: props.monitor }
        : null;
    setSession({
      key,
      server,
      seed,
      error: session.server === server ? props.initialSearchError : null,
    });
  }
  return (
    <RecallSearchSession
      key={session.key}
      {...props}
      initialSearch={session.seed}
      initialSearchError={session.error}
      server={server}
    />
  );
}

function subscribeServerScope(change: () => void) {
  window.addEventListener("storage", change);
  window.addEventListener("focus", change);
  return () => {
    window.removeEventListener("storage", change);
    window.removeEventListener("focus", change);
  };
}
function emptyServerScope() {
  return "";
}

/** OCR full-text search over an agent's captured screens, with frame previews. */
type SearchSessionProps = RecallSearchProps & { server: string };
function RecallSearchSession(props: SearchSessionProps) {
  const model = useRecallSearchModel(props);
  return <SearchPanel model={model} props={props} />;
}
function useRecallSearchModel({
  agentId,
  monitor,
  range,
  timezone,
  preferencesKey,
  initialSearch,
  initialSearchError,
  onSearchStateChange,
  server,
}: SearchSessionProps) {
  const {
    searchMonitor,
    setSearchMonitor,
    query,
    setQuery,
    filters,
    setFilters,
    restoredBounds,
    setRestoredBounds,
    linkedError,
    setLinkedError,
    scope,
    setScope,
    sort,
    setSort,
    from,
    setFrom,
    to,
    setTo,
    resetDraft,
  } = useRecallSearchDraft({ initialSearch, initialSearchError, monitor });
  const requestScope = JSON.stringify([
    agentId,
    monitor,
    preferencesKey,
    server,
  ]);
  const latestScope = useRef(requestScope);
  const abort = useRef<AbortController | null>(null);
  const publishSearchLocation = useEffectEvent((search: SavedSearch | null) =>
    onSearchStateChange?.(search),
  );
  // The draft-restore and fetch callbacks below read these between renders;
  // mirror the latest props here (before the layout effects that consume them)
  // so they never close over a stale render snapshot.
  useLayoutEffect(() => {
    latestScope.current = requestScope;
  });
  const [results, setResults] = useState<ScreenFrameSearchResult[] | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [cursor, setCursor] = useState<string | null>(null);
  const [complete, setComplete] = useState<boolean | null>(null);
  const [savedState, setSavedState] = useState<{
    key: string | null | undefined;
    items: SavedSearch[];
  }>({ key: preferencesKey, items: [] });
  const saved = savedState.key === preferencesKey ? savedState.items : [];
  const setSaved = (items: SavedSearch[]) =>
    setSavedState({ key: preferencesKey, items });
  // Saved searches live in this browser for this server/user/device scope; a
  // new scope reloads them during render.
  const [prevSavedScope, setPrevSavedScope] = useState(preferencesKey);
  if (prevSavedScope !== preferencesKey) {
    setPrevSavedScope(preferencesKey);
    setSavedState({
      key: preferencesKey,
      items: preferencesKey
        ? readItems<unknown>(`${preferencesKey}:searches`)
            .map(parseSavedSearch)
            .filter((s): s is SavedSearch => s !== null)
        : [],
    });
  }
  const [groupSimilar, setGroupSimilar] = useState(true);
  // The last executed search: read by the status line and the save/refresh
  // actions, so it lives in state rather than a ref.
  const [frozen, setFrozen] = useState<{
    query: string;
    opts: HistorySearchOpts;
  } | null>(null);
  const busy = useRef(false);
  const seenCursors = useRef(new Set<string>());
  const generation = useRef(0);
  const cancelPendingRequest = useCallback(() => {
    generation.current++;
    abort.current?.abort();
    abort.current = null;
    busy.current = false;
  }, []);
  const invalidate = useCallback(() => {
    generation.current++;
    abort.current?.abort();
    abort.current = null;
    busy.current = false;
    setFrozen(null);
    setCursor(null);
    setComplete(null);
    setResults(null);
    setError(null);
    setSearching(false);
  }, []);
  const lastVerified = useRef(preferencesKey ?? null);
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
  useLayoutEffect(() => {
    cancelPendingRequest();
    // Null is a temporary verification scope: mask results/saves, retain draft.
    // A different confirmed identity clears it without replaying an old URL seed.
    if (preferencesKey) {
      if (lastVerified.current && lastVerified.current !== preferencesKey)
        resetDraft(false);
      lastVerified.current = preferencesKey;
    }
    return cancelPendingRequest;
  }, [requestScope, preferencesKey, resetDraft, cancelPendingRequest]);
  useEffect(
    () =>
      onSessionExpired(() => {
        invalidate();
        resetDraft(false);
        setSavedState({ key: null, items: [] });
      }),
    [invalidate, resetDraft],
  );

  // Changes to the selected window invalidate its cursor, even while a page is pending.
  // The state resets derive during render; the effect below only cancels the
  // in-flight work.
  const selectedRangeKey =
    scope === "selected"
      ? `${range?.fromMs ?? "start"}:${range?.toMs ?? "end"}`
      : null;
  const [prevSelectedRangeKey, setPrevSelectedRangeKey] =
    useState(selectedRangeKey);
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
      abort.current?.abort();
      abort.current = null;
      busy.current = false;
    }
  }, [range?.fromMs, range?.toMs, scope]);
  const fetchPage = (
    snapshot: { query: string; opts: HistorySearchOpts },
    next?: string,
  ) => {
    if (busy.current || preferencesKey === null) return;
    busy.current = true;
    const request = generation.current,
      context = requestScope;
    const controller = new AbortController();
    abort.current = controller;
    const valid = () =>
      request === generation.current &&
      latestScope.current === context &&
      fleetServerScope() === server &&
      !controller.signal.aborted;
    setSearching(true);
    setError(null);
    api
      .historySearch(
        agentId,
        snapshot.query,
        { ...snapshot.opts, cursor: next },
        controller.signal,
      )
      .then((res) => {
        if (!valid()) return;
        const expected = parseRecallFilters({
          app: snapshot.opts.app,
          app_mode: snapshot.opts.app_mode,
          title: snapshot.opts.title,
          url_host: snapshot.opts.url_host,
          context: snapshot.opts.context,
        });
        if (
          res.filters &&
          JSON.stringify(parseRecallFilters(res.filters)) !==
            JSON.stringify(expected)
        )
          throw new Error(
            "The server returned different context filters. Clear filters and search again.",
          );
        if (contextFiltersActive(expected) && !res.filters)
          throw new Error(
            "This server does not support the selected context filters. Clear filters to use OCR search.",
          );
        const continuation = res.next_cursor ?? null;
        if (res.has_more && !continuation)
          throw new Error(
            "Search is incomplete but has no continuation cursor. Search again to retry.",
          );
        if (continuation && seenCursors.current.has(continuation))
          throw new Error(
            "Search pagination did not advance. Search again to retry.",
          );
        if (continuation) seenCursors.current.add(continuation);
        setResults((previous) =>
          valid()
            ? [
                ...new Map(
                  [...(next ? (previous ?? []) : []), ...res.results].map(
                    (hit) => [hit.id, hit],
                  ),
                ).values(),
              ]
            : previous,
        );
        setCursor(continuation);
        setComplete(continuation ? false : (res.complete ?? null));
      })
      .catch((e) => {
        if (valid()) setError(errorText(e));
      })
      .finally(() => {
        if (valid()) {
          busy.current = false;
          setSearching(false);
        }
      });
  };
  let normalized: RecallContextFilters | null = null,
    filterError: string | null = null;
  try {
    normalized = parseRecallFilters(filters);
  } catch (e) {
    filterError = errorText(e);
  }
  const active = normalized ? contextFiltersActive(normalized) : false;
  const effectiveSort = query.trim() ? sort : "newest";
  const filterOpts = (
    value: RecallContextFilters,
  ): Partial<RecallContextFilters> =>
    contextFiltersActive(value) ? { ...value } : {};
  const clearFilters = () => {
    invalidate();
    setFilters({ ...EMPTY_CONTEXT_FILTERS });
    setLinkedError(null);
  };
  const runSearch = (savedSearch?: SavedSearch) => {
    const validSaved = savedSearch ? parseSavedSearch(savedSearch) : null;
    const q = (validSaved?.query ?? query).trim();
    const selected = validSaved?.filters ?? normalized;
    if (!selected || new TextEncoder().encode(q).length > 4096) {
      invalidate();
      setError(filterError ?? "OCR query exceeds 4096 UTF-8 bytes.");
      return;
    }
    if (!q && !contextFiltersActive(selected)) return;
    let opts: HistorySearchOpts = {
      scope: validSaved?.scope ?? (scope === "retained" ? "retained" : "range"),
      sort: q ? (validSaved?.sort ?? sort) : "newest",
      monitor: validSaved ? validSaved.monitor : searchMonitor,
      limit: 100,
      ...filterOpts(selected),
    };
    if (validSaved?.scope === "range")
      opts = { ...opts, from: validSaved.from, to: validSaved.to };
    else if (!validSaved && scope !== "retained") {
      const start =
        scope === "selected"
          ? range?.fromMs
          : restoredBounds
            ? Date.parse(restoredBounds.from)
            : deviceTime(from, timezone);
      const end =
        scope === "selected"
          ? range?.toMs
          : restoredBounds
            ? Date.parse(restoredBounds.to)
            : deviceTime(to, timezone);
      if (start == null || end == null || start >= end) {
        invalidate();
        setError(
          "Enter a valid start and later end in the device timezone. Ambiguous or skipped DST times are invalid.",
        );
        return;
      }
      opts = {
        ...opts,
        from: new Date(start).toISOString(),
        to: new Date(end).toISOString(),
      };
    }
    if (validSaved) {
      setSearchMonitor(validSaved.monitor);
      setQuery(validSaved.query);
      setFilters(validSaved.filters!);
      setSort(validSaved.sort);
      setScope(validSaved.scope === "range" ? "dates" : "retained");
      setRestoredBounds(
        validSaved.scope === "range"
          ? { from: validSaved.from!, to: validSaved.to! }
          : null,
      );
      setFrom("");
      setTo("");
    }
    invalidate();
    seenCursors.current.clear();
    setLinkedError(null);
    const snapshot = { query: q, opts: Object.freeze({ ...opts }) };
    setFrozen(snapshot);
    fetchPage(snapshot);
  };
  // This publishes a bookmark to React Router, an external browser system; it
  // does not fetch data or maintain another copy of component-owned state.
  useEffect(() => {
    let restored: SavedSearch | null = null;
    if (normalized && (query.trim() || contextFiltersActive(normalized))) {
      if (scope === "retained")
        restored = {
          query: query.trim(),
          scope: "retained",
          sort: effectiveSort,
          monitor: searchMonitor,
          filters: normalized,
        };
      else {
        const start =
          scope === "selected"
            ? range?.fromMs
            : restoredBounds
              ? Date.parse(restoredBounds.from)
              : deviceTime(from, timezone);
        const end =
          scope === "selected"
            ? range?.toMs
            : restoredBounds
              ? Date.parse(restoredBounds.to)
              : deviceTime(to, timezone);
        if (start != null && end != null && start < end)
          restored = {
            query: query.trim(),
            scope: "range",
            sort: effectiveSort,
            monitor: searchMonitor,
            from: new Date(start).toISOString(),
            to: new Date(end).toISOString(),
            filters: normalized,
          };
      }
    }
    // React Router bookmark synchronization; no parent-owned render state is copied.
    // react-doctor-disable-next-line react-doctor/no-pass-data-to-parent
    publishSearchLocation(restored);
    // Depend on scalar draft identity rather than a newly normalized object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    query,
    filters,
    scope,
    effectiveSort,
    searchMonitor,
    from,
    to,
    timezone,
    range?.fromMs,
    range?.toMs,
    restoredBounds,
  ]);
  const saveSearch = () => {
    if (!preferencesKey || !frozen) return;
    const { query: q, opts } = frozen;
    const item: SavedSearch = {
      query: q,
      scope: opts.scope ?? "retained",
      sort: opts.sort ?? "ranked",
      monitor: opts.monitor ?? null,
      from: opts.from,
      to: opts.to,
      filters: parseRecallFilters({
        app: opts.app,
        app_mode: opts.app_mode,
        title: opts.title,
        url_host: opts.url_host,
        context: opts.context,
      }),
    };
    const next = [
      item,
      ...saved.filter((s) => JSON.stringify(s) !== JSON.stringify(item)),
    ].slice(0, 100);
    if (writeItems(`${preferencesKey}:searches`, next)) setSaved(next);
    else setError("Browser storage is unavailable; search was not saved.");
  };

  return {
    preferencesKey,
    searchMonitor,
    query,
    setQuery,
    invalidate,
    runSearch,
    filterError,
    active,
    results,
    searching,
    error,
    linkedError,
    setLinkedError,
    scope,
    setScope,
    range,
    effectiveSort,
    sort,
    setSort,
    from,
    setFrom,
    to,
    setTo,
    setRestoredBounds,
    timezone,
    groupSimilar,
    setGroupSimilar,
    saveSearch,
    frozen,
    filters,
    setFilters,
    clearFilters,
    restoredBounds,
    saved,
    setSaved,
    setError,
    cursor,
    complete,
    fetchPage,
  };
}
type SearchModel = ReturnType<typeof useRecallSearchModel>;
type SearchPanelProps = { model: SearchModel; props: SearchSessionProps };

function SearchHit({
  hit: r,
  agentId,
  onSeek,
  timezone,
}: {
  hit: ScreenFrameSearchResult;
  agentId: string;
  onSeek: RecallSearchProps["onSeek"];
  timezone: string | null;
}) {
  return (
    <button
      onClick={() => onSeek(r.captured_at, r.monitor, r.id)}
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
        <span className="text-[13px] [overflow-wrap:anywhere]">
          {renderSnippet(r.snippet)}
        </span>
        <RecallCaptureContext context={r.context} compact />
      </span>
    </button>
  );
}

function SearchPanel({ model, props }: SearchPanelProps) {
  return (
    <div className="recall-search rounded-xl bg-card p-5">
      <SearchQueryControls model={model} props={props} />
      <SearchScopeControls model={model} props={props} />
      <SearchContextFilters model={model} props={props} />
      <SavedSearches model={model} props={props} />
      <SearchResultsStatus model={model} props={props} />
      <SearchResults model={model} props={props} />
    </div>
  );
}

function SearchQueryControls({ model }: SearchPanelProps) {
  const {
    preferencesKey,
    searchMonitor,
    query,
    setQuery,
    invalidate,
    runSearch,
    filterError,
    active,
    results,
    searching,
    error,
    linkedError,
    setFilters,
    setLinkedError,
  } = model;
  return (
    <>
      {preferencesKey === null && (
        <p role="status" className="mb-2 text-sm text-muted-foreground">
          Checking your account…
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Searching screen text on{" "}
        {searchMonitor == null
          ? "all displays"
          : `display ${searchMonitor + 1}`}
        .
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
        <Input
          type="search"
          value={query}
          aria-label="Search screen text"
          onChange={(e) => {
            invalidate();
            setQuery(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") runSearch();
          }}
          placeholder="Search all screen text (OCR)…"
          className="h-9 max-w-115 min-w-0 flex-[1_1_180px]"
        />
        <Button
          onClick={() => runSearch()}
          disabled={
            preferencesKey === null ||
            Boolean(filterError) ||
            (query.trim() === "" && !active)
          }
        >
          Search
        </Button>
        {(query ||
          active ||
          results !== null ||
          searching ||
          error ||
          linkedError) && (
          <Button
            variant="link"
            onClick={() => {
              invalidate();
              setQuery("");
              setFilters({ ...EMPTY_CONTEXT_FILTERS });
              setLinkedError(null);
            }}
          >
            Clear
          </Button>
        )}
      </div>
    </>
  );
}

function SearchScopeControls({ model }: SearchPanelProps) {
  const {
    scope,
    setScope,
    range,
    effectiveSort,
    query,
    invalidate,
    setSort,
    from,
    setFrom,
    to,
    setTo,
    setRestoredBounds,
    timezone,
    groupSimilar,
    setGroupSimilar,
    saveSearch,
    preferencesKey,
    frozen,
    searching,
  } = model;
  return (
    <>
      <div className="recall-retrieval-fields">
        <Label>
          Search scope{" "}
          <select
            aria-label="Search scope"
            value={scope}
            onChange={(e) => {
              invalidate();
              setScope(e.target.value as typeof scope);
            }}
            className="h-9 rounded-lg bg-muted/70 px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="retained">All retained history</option>
            <option value="selected" disabled={!range}>
              Selected playback range
            </option>
            <option value="dates">Custom dates</option>
          </select>
        </Label>
        <Label>
          Order{" "}
          <select
            aria-label="Search order"
            value={effectiveSort}
            disabled={!query.trim()}
            onChange={(e) => {
              invalidate();
              setSort(e.target.value as "ranked" | "newest");
            }}
            className="h-9 rounded-lg bg-muted/70 px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <option value="ranked">Relevance</option>
            <option value="newest">Newest first</option>
          </select>
        </Label>
        {scope === "dates" && (
          <>
            <Label>
              Search from{" "}
              <Input
                type="datetime-local"
                value={from}
                onChange={(e) => {
                  invalidate();
                  setFrom(e.target.value);
                  setRestoredBounds(null);
                }}
                className="h-9"
              />
            </Label>
            <Label>
              Search to{" "}
              <Input
                type="datetime-local"
                value={to}
                onChange={(e) => {
                  invalidate();
                  setTo(e.target.value);
                  setRestoredBounds(null);
                }}
                className="h-9"
              />
            </Label>
            <span className="text-xs text-muted-foreground">
              Device timezone:{" "}
              {timezone ?? "unavailable — date search disabled"}
            </span>
          </>
        )}
      </div>
      <div className="recall-retrieval-fields recall-retrieval-actions">
        <Label className="recall-inline-check">
          <input
            type="checkbox"
            checked={groupSimilar}
            onChange={(e) => setGroupSimilar(e.target.checked)}
            className="size-4.5 accent-primary"
          />{" "}
          Group similar captures
        </Label>
        <Button
          variant="outline"
          onClick={saveSearch}
          disabled={!preferencesKey || !frozen || searching}
        >
          Save search
        </Button>
      </div>
    </>
  );
}

function SearchContextFilters({ model }: SearchPanelProps) {
  const {
    active,
    filters,
    invalidate,
    setFilters,
    query,
    restoredBounds,
    filterError,
    linkedError,
    clearFilters,
  } = model;
  return (
    <>
      <details className="recall-context-filters">
        <summary>
          Filter by app, title or site{active ? " (active)" : ""}{" "}
          {/* Cancel the click so the tip does not also toggle the section. */}
          <span onClick={(event) => event.preventDefault()}>
            <HelpTip>
              Uses the app in the foreground around each capture, which may
              differ from what is visible on this display. App names match as
              recorded, including .exe. Titles match literally, ignoring case.
              Sites match the exact host, without subdomains, and only for
              recordings that include one.
            </HelpTip>
          </span>
        </summary>
        <div className="recall-retrieval-fields">
          <Label>
            App{" "}
            <Input
              aria-label="Foreground app around capture"
              value={filters.app ?? ""}
              maxLength={256}
              placeholder="editor.exe"
              onChange={(e) => {
                invalidate();
                setFilters({
                  ...filters,
                  app: e.target.value,
                  app_mode: e.target.value.trim() ? filters.app_mode : "exact",
                });
              }}
              className="h-9"
            />
          </Label>
          <Label>
            Match{" "}
            <select
              aria-label="App match"
              value={filters.app_mode}
              disabled={!filters.app?.trim()}
              onChange={(e) => {
                invalidate();
                setFilters({
                  ...filters,
                  app_mode: e.target.value as RecallContextFilters["app_mode"],
                });
              }}
              className="h-9 rounded-lg bg-muted/70 px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <option value="exact">Exact</option>
              <option value="prefix">Starts with</option>
            </select>
          </Label>
          <Label>
            Window title contains{" "}
            <Input
              aria-label="Foreground title contains"
              value={filters.title ?? ""}
              maxLength={1024}
              onChange={(e) => {
                invalidate();
                setFilters({ ...filters, title: e.target.value });
              }}
              className="h-9"
            />
          </Label>
          <Label>
            Site{" "}
            <Input
              aria-label="Exact host"
              value={filters.url_host ?? ""}
              maxLength={253}
              placeholder="docs.example.com"
              onChange={(e) => {
                invalidate();
                setFilters({ ...filters, url_host: e.target.value });
              }}
              className="h-9"
            />
          </Label>
          <Label>
            App known{" "}
            <select
              aria-label="Capture context"
              value={filters.context}
              onChange={(e) => {
                invalidate();
                setFilters({
                  ...filters,
                  context: e.target.value as RecallContextFilters["context"],
                });
              }}
              className="h-9 rounded-lg bg-muted/70 px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="all">Any</option>
              <option value="known">Known</option>
              <option value="unknown">Unknown</option>
            </select>
          </Label>
          <Button
            variant="outline"
            onClick={clearFilters}
            disabled={!active && !filterError && !linkedError}
          >
            Clear filters
          </Button>
        </div>
        {!query.trim() && active && (
          <p role="status" className="text-sm text-muted-foreground">
            No search text, so the newest matching captures are shown.
          </p>
        )}
        {restoredBounds && (
          <p className="text-sm text-muted-foreground">
            Restored exact range: {restoredBounds.from} – {restoredBounds.to}
          </p>
        )}
      </details>
      {(filterError || linkedError) && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {" "}
          {filterError || linkedError}{" "}
          <Button variant="outline" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        </p>
      )}
    </>
  );
}

function SavedSearches({ model }: SearchPanelProps) {
  const { saved, setQuery, runSearch, preferencesKey, setSaved, setError } =
    model;
  return (
    <>
      {saved.length > 0 && (
        <div aria-label="Saved searches" className="mt-2 flex flex-col gap-2">
          {saved.map((item, i) => (
            <div key={JSON.stringify(item)} className="recall-retrieval-fields">
              <Button
                variant="outline"
                className="h-auto min-w-0 justify-start whitespace-normal py-2 text-left break-words"
                onClick={() => {
                  setQuery(item.query);
                  runSearch(item);
                }}
              >
                Run saved: {item.query || "Context only"} ·{" "}
                {item.filters?.app
                  ? `app ${item.filters.app} (${item.filters.app_mode}) · `
                  : ""}
                {item.filters?.title ? `title ${item.filters.title} · ` : ""}
                {item.filters?.url_host
                  ? `host ${item.filters.url_host} · `
                  : ""}
                {item.filters?.context && item.filters.context !== "all"
                  ? `${item.filters.context} context · `
                  : ""}
                {item.sort} · {item.scope}
                {item.from ? ` · ${item.from} – ${item.to}` : ""} ·{" "}
                {item.monitor == null
                  ? "all displays"
                  : `display ${item.monitor + 1}`}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  const next = saved.filter((_, j) => i !== j);
                  if (
                    preferencesKey &&
                    writeItems(`${preferencesKey}:searches`, next)
                  )
                    setSaved(next);
                  else setError("Could not remove saved search.");
                }}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function SearchResultsStatus({ model }: SearchPanelProps) {
  const {
    results,
    frozen,
    cursor,
    complete,
    runSearch,
    searching,
    filterError,
    fetchPage,
    error,
  } = model;
  return (
    <>
      {results !== null && (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {results.length} matches loaded for “{frozen?.query}” ·{" "}
          {frozen?.opts.sort === "newest" ? "Newest first" : "Relevance"} ·{" "}
          {frozen?.opts.scope === "retained"
            ? "All retained history"
            : `${frozen?.opts.from} – ${frozen?.opts.to}`}
          .{" "}
          {cursor
            ? "More matches available."
            : complete === true
              ? "Search complete."
              : complete === false
                ? "Search incomplete."
                : "Completeness unknown."}{" "}
          <Button
            variant="link"
            size="sm"
            onClick={() => runSearch()}
            disabled={searching || Boolean(filterError)}
          >
            Refresh search
          </Button>
        </p>
      )}
      {cursor && (
        <Button
          variant="outline"
          onClick={() => {
            if (frozen) fetchPage(frozen, cursor);
          }}
          disabled={searching}
        >
          Load more
        </Button>
      )}
      {error && (
        <p role="alert" className="pt-1 text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

function SearchResults({ model, props }: SearchPanelProps) {
  const {
    results,
    groupSimilar,
    clearFilters,
    runSearch,
    searching,
    filterError,
    timezone,
  } = model;
  const { agentId, onSeek } = props;
  const renderResult = (hit: ScreenFrameSearchResult) => (
    <SearchHit
      key={`${agentId}:${hit.id}`}
      hit={hit}
      agentId={agentId}
      onSeek={onSeek}
      timezone={timezone}
    />
  );
  return (
    <>
      {results !== null && (
        <div className="mt-2.5 max-h-80 divide-y divide-foreground/[0.06] overflow-y-auto rounded-xl bg-muted/50">
          {results.length === 0 ? (
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
              No retained screens matched this text and context in this scope.
              Older recordings may have expired.
              <Button variant="outline" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => runSearch()}
                disabled={searching || Boolean(filterError)}
              >
                Refresh search
              </Button>
            </div>
          ) : (
            (groupSimilar
              ? groupSearchHits(results)
              : results.map((hit) => [hit])
            ).map((group) =>
              group.length === 1 ? (
                renderResult(group[0])
              ) : (
                <details
                  key={`group:${agentId}:${group[0].id}`}
                  className="recall-search-group"
                >
                  <summary>
                    {group.length} similar captures · Display{" "}
                    {group[0].monitor + 1} ·{" "}
                    {shortDateIn(timezone, Date.parse(group[0].captured_at))}{" "}
                    {timeIn(timezone, group[0].captured_at)} — expand to choose
                    a recording
                  </summary>
                  {group.map(renderResult)}
                </details>
              ),
            )
          )}
        </div>
      )}
    </>
  );
}

function useRecallSearchDraft({
  initialSearch,
  initialSearchError,
  monitor,
}: Pick<
  RecallSearchProps,
  "initialSearch" | "initialSearchError" | "monitor"
>) {
  const seedRef = useRef({ initialSearch, initialSearchError });
  const seed = initialSearch ? parseSavedSearch(initialSearch) : null;
  const monitorRef = useRef(monitor);
  const [searchMonitor, setSearchMonitor] = useState<number | null>(
    seed ? seed.monitor : monitor,
  );
  const [query, setQuery] = useState(seed?.query ?? "");
  const [filters, setFilters] = useState<RecallContextFilters>(
    seed?.filters ?? { ...EMPTY_CONTEXT_FILTERS },
  );
  const [restoredBounds, setRestoredBounds] = useState<{
    from: string;
    to: string;
  } | null>(
    seed?.scope === "range" ? { from: seed.from!, to: seed.to! } : null,
  );
  const [linkedError, setLinkedError] = useState(initialSearchError ?? null);
  const [scope, setScope] = useState<"retained" | "selected" | "dates">(
    seed?.scope === "range" ? "dates" : "retained",
  );
  const [sort, setSort] = useState<"ranked" | "newest">(seed?.sort ?? "ranked");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  useLayoutEffect(() => {
    seedRef.current = { initialSearch, initialSearchError };
    monitorRef.current = monitor;
  });
  const resetDraft = useCallback((restore: boolean) => {
    const initial = seedRef.current;
    const restored =
      restore && initial.initialSearch
        ? parseSavedSearch(initial.initialSearch)
        : null;
    setSearchMonitor(restored ? restored.monitor : monitorRef.current);
    setQuery(restored?.query ?? "");
    setFilters(restored?.filters ?? { ...EMPTY_CONTEXT_FILTERS });
    setSort(restored?.sort ?? "ranked");
    setScope(restored?.scope === "range" ? "dates" : "retained");
    setRestoredBounds(
      restored?.scope === "range"
        ? { from: restored.from!, to: restored.to! }
        : null,
    );
    setFrom("");
    setTo("");
    setLinkedError(restore ? (initial.initialSearchError ?? null) : null);
  }, []);
  return {
    searchMonitor,
    setSearchMonitor,
    query,
    setQuery,
    filters,
    setFilters,
    restoredBounds,
    setRestoredBounds,
    linkedError,
    setLinkedError,
    scope,
    setScope,
    sort,
    setSort,
    from,
    setFrom,
    to,
    setTo,
    resetDraft,
  };
}
