# Recall capture context: implementation contract

Design for review, 2026-10-04. Documentation only. Uses the selected standard module policy: device-local grants, server-only stops, with documented same-identity code/input limits. No hardware or isolation dependency.

## What exists

[screen_history.rs](../src/screen_history.rs) captures each monitor separately, deduplicates pixels, then performs OCR/JPEG encoding. `HistoryFrame.captured_at` currently uses `Utc::now()` **after** those operations. Frames contain Recall generation, timestamp, monitor/size/hash, OCR and JPEG; no app/title/URL.

[screen_spool.rs](../src/screen_spool.rs) assigns a stable UUID, writes header/JPEG together via temporary-file rename, and bounds disk use. [agent_loop.rs](../src/agent_loop.rs) captures/spools independently of connection, uploads `HST\0 + u32 header length + JSON + JPEG`, retries until ack, and discards stale Recall-generation entries when pumping. Final writer [permissions/fence.rs](../src/permissions/fence.rs) validates the outer `VGN1` Recall fence, then strips it. It does not currently redact secondary metadata in binary frames.

Window/URL polling is separate. Windows [window_tracker.rs](../src/window_tracker.rs) emits changes, not capture snapshots. Linux [activity_tracker.rs](../src/platform/linux/activity_tracker.rs) supports Hyprland; its `hwnd` is a PID, insufficient to distinguish two windows of one process. Linux URL provider returns none. Windows [url_scraper.rs](../src/url_scraper.rs) delegates to the patched browser library; its [UIA extractor](../patches/browser-url/src/platform/windows.rs) searches the desktop by **title**, with 10-second timeouts. `BrowserInfo` has PID/geometry but the platform `ActiveUrl` discards these. Neither latest activity nor that title-matched URL is reliable capture attribution.

Server `server/src/ws_agent.rs` accepts binary and legacy JSON/base64 frames through `store_history_frame`, under lifecycle ingestion leases and Recall authorization. `server/src/db/screen_history.rs` stores day-partitioned rows, currently deduplicating `(captured_at, client_uid)` via migration 0063; duplicate retries ack and discard their redundant blob. Missing/invalid timestamp currently falls back to server-now, which defeats stable retry identity for malformed modern frames. Search uses OCR only, rank/time/id keysets, and API cursors freeze device/query/time/monitor/scope/sort but **are not DB snapshots**.

## Meaning and consistency

Context means **session foreground activity observed around this monitor's capture**, not “the only app visible in the screenshot.” Multiple visible windows and background monitors make that distinction necessary. Do not join latest activity rows, infer URL from window title/OCR, or retroactively fill older frames.

Add a dedicated snapshot provider, separate from event dedup. Per monitor:

1. Capture Recall generation and separately optional WindowActivity/BrowserUrls generations. Do not call a metadata reader whose grant is absent.
2. Read foreground identity/context immediately before capture; record monotonic timing. Record `captured_at` at screenshot-call start and `capture_duration_ms` at completion, **before** OCR/encoding. Context sampling must not share one snapshot across a whole multi-monitor batch.
3. Read identity/context again immediately after screenshot. Stable window requires same desktop/session, native window identity plus process identity, app identity and title. Linux uses Hyprland window address, not PID alone. URL needs two equal normalized samples associated with that same native window; title equality is insufficient.
4. Require the entire sampling bracket ≤1,000 ms; slower/failed probes produce unknown/uncertain context and still allow the image. Use genuinely bounded OS/subprocess calls; spawning unbounded UIA tasks and timing out their receiver would leak workers. Initial window slice can use a tighter 250 ms budget; URL work must obey the overall budget.
5. Recheck each original generation before constructing/enqueuing the frame. A metadata revoke/regrant strips that component; Recall revoke drops the whole frame. One owned frame object associates metadata and pixels in channel/spool persistence.

Repeated reads demonstrate **bracket consistency**, not an atomic OS snapshot. An A→B→A focus/tab change between reads or a compositor framebuffer lag can escape detection. Use status `observed`, never `exact`. Detected identity/title/tab change is `uncertain`; publish no candidate app/title/URL for filtering in that case. No provider must pretend to supply atomic evidence. Future compositor-correlated capture may strengthen this separately. Extend per-monitor dedup to compare the validated observed context signature as well as pixel hash: a changed app/title/host can retain a keyframe at the existing cadence even when pixels are near-identical. Do not include timestamps or temporary error strings in that signature; unknown/error oscillation must not create uncontrolled capture flooding.

Window/URL association must be independent: BrowserUrls alone may use an ephemeral opaque window token to associate URL reads, but cannot export app/title/path. WindowActivity alone yields app/title, never URL. Do not retain HWND/PID/path in server metadata. Default monitor relation is `unknown`; report same/other monitor only when the native window bounds establish an unambiguous association. Filters intentionally refer to session foreground context on all monitors; UI explains this.

## Additive wire/spool contract

Keep existing `HST\0`, JPEG and required header keys. Add optional `context`; old agents/spools omit it and old servers ignore it. New backend should ship first. Missing context is SQL NULL/API null, not a fabricated object.

```json
{
  "uid": "existing-frame-uuid",
  "captured_at": "2026-10-04T04:12:30.123Z",
  "capture_duration_ms": 24,
  "context": {
    "version": 1,
    "scope": "session_foreground",
    "bracket_ms": 48,
    "monitor_relation": "unknown",
    "window": {
      "status": "observed", "reason": null,
      "source": "win32", "app": "msedge.exe", "title": "Documentation"
    },
    "browser": {
      "status": "observed", "reason": null,
      "source": "uia_hwnd", "url": null, "url_host": "docs.example.com"
    },
    "grant_revisions": {"window_activity": 12, "browser_urls": 9}
  }
}
```

Each component status is `observed | uncertain | unknown | not_collected`. Only observed may carry values; individual unavailable fields remain null. Reasons are bounded enums: `module_disabled`, `revoked`, `unsupported`, `no_foreground`, `not_browser`, `read_failed`, `sample_timeout`, `changed`, `identity_unverified`, `invalid_url`, `invalid_context`. `not_collected` distinguishes grant denial/revocation from provider failure. `source` enum: window `win32|hyprland|none`; browser `uia_hwnd|none`. No display label/absolute executable path is needed initially.

Privacy-minimal first URL slice stores **host only**, with `url:null`. This is URL-derived context, not a full navigation history. Reserve nullable `url` for an explicitly reviewed later path feature; do not populate it with inferred schemes or unseen paths. URL reader accepts completed HTTP(S) URLs with an explicit valid scheme/host, canonicalizes IDNA/lowercase host, removes trailing dot, excludes credentials/query/fragment and ports from host. No assumed `https://` for a scheme-less omnibox value. Reject internal/file/extension schemes for host attribution. Localhost/IP hosts can be exact-filtered; normalize IPv4 and IPv6 through the URL host parser, storing IPv6 without brackets and accepting bracketed or bare IPv6 filter literals without treating them as ports. Full URLs in existing activity telemetry do not authorize copying them indiscriminately into Recall.

Bounds: UTF-8 app ≤256 bytes, title ≤1,024 bytes, canonical host ≤253 bytes, reserved URL ≤2,048 bytes, context JSON ≤4 KiB; capture duration/bracket integers 0..1,000. Strip NUL/control characters except ordinary spaces; truncate title at a UTF-8 boundary and record optional `title_truncated:true`. Oversized app becomes null rather than a different truncated identity. Reject invalid enum/schema/value combinations component-wise; normalize to unknown without discarding a valid image. Unknown version drops context. Broad malformed/oversized frame/header validation remains a separate bounded ingest concern.

`grant_revisions` has only the two optional metadata module revisions, required for populated components. Agent Rust keeps u64; server handles JSON integer exactly. Do not use these for JS arithmetic. API omits these ingestion-only fields.

## Revocation, delayed spools and retry identity

Store optional context and original metadata generations using `#[serde(default)]` alongside the original Recall fence. Old spool files load as no context. Sample **once**, never at upload/retry time. OCR/encoding delay and offline delivery must not change context/timestamp/UID.

Sanitize before spool write and again before each send: stale WindowActivity strips app/title; stale BrowserUrls strips host/URL. Recall stale drops the frame. Do not stamp old context with a newly enabled revision. On-demand invalidation prevents replay after regrant; background bounded spool scrubbing on metadata revoke removes sensitive stored fields without claiming secure physical erasure. Revocation is not deletion of already accepted server history; pixels/OCR may themselves show titles/URLs even when metadata grants are off.

Close enqueue→socket races at `permissions::prepare_message`: extend the internal VGN1 envelope compatibly with optional secondary generations, retain them through IPC, and parse/rebuild the nested HST header to redact stale fields at the final network writer. Today's binary branch only strips VGN1; pump-only validation is insufficient. Internal fences must not leak onto the external protocol. Server additionally validates populated components against the current connection's module report and exact revision (and pending stops) immediately before insertion, retaining the lifecycle lease. Drop unauthorized metadata, not otherwise authorized Recall pixels. Do not hold parking_lot guards across await. These checks are protocol enforcement, not a guarantee against malicious same-identity client code.

Keep UUID/timestamp/monitor immutable on retries. For context-bearing modern frames require valid timestamp and UID; reject/ack permanent invalid identity instead of falling back to now. Preserve legacy acceptance behavior without inventing context. Correct agent-scoped dedup in a new migration to `(agent_id,captured_at,client_uid)`; the current unique index omits agent_id. Same UID/timestamp from another agent must not suppress that agent's frame. Changed timestamp remains outside that key; modern agents must not change it.

First accepted row wins: no conflict-upsert of app/title/URL after a lost ack. A retry whose context is redacted must neither rehydrate nor erase already accepted history. Preserve redundant-blob cleanup and ack semantics. Optional conflict diagnostics must not log sensitive values.

## DB and API contract

New next-number migration (choose number after other delegates finish): nullable `capture_duration_ms integer`, `capture_context jsonb`, and nullable server-derived `context_app text`, `context_title text`, `context_url_host text`. JSON holds bounded statuses/evidence; filter columns contain only validated observed values. All retained rows remain NULL; no activity-table backfill. Keep existing OCR vector unchanged so context cannot alter OCR relevance. Initial indexes: `(agent_id,context_app,captured_at DESC,id DESC)` and corresponding host index, partial where value non-null; measure prefix/title plans before adding trigram indexes. Derive canonical app key by ASCII lowercase; preserve original app in JSON. No friendly-name/path alias matching.

Existing `GET /agents/:id/history/frames`, frame-at, and search results add `context:null|sanitizedContext` and nullable capture duration. No per-row request. Ingestion-only revisions are removed. Text/word/image endpoints remain compatible.

Extend `/history/search` with AND filters:

| Parameter | Semantics |
| --- | --- |
| `app` + `app_mode=exact|prefix` | ASCII-case-folded canonical executable/class identity; exact is default. Prefix is literal, SQL wildcard characters escaped, no automatic `.exe` removal. |
| `title` | Literal case-insensitive substring, not regex/FTS; explicit field separate from OCR `q`. Declare deterministic PostgreSQL collation behavior and test Unicode rather than promising cross-platform case folding. |
| `url_host` | IDNA/case/trailing-dot normalized **exact host**, no scheme/path/port or implicit subdomains; `example.com` excludes `a.example.com`. Invalid input is 400. |
| `context=all|known|unknown` | All default. Known means at least one observed non-null app/title/host; unknown is its complement, including old rows/disabled/failed/uncertain. All data filters inherently exclude absent values; combining unknown with a data filter is 400. |

`q` retains OCR websearch/rank semantics and 4,096-byte limit. Allow context-only search when at least one context filter is active: omitted/blank q uses rank 0 and newest order; explicit ranked without OCR is 400. Existing unfiltered blank query remains 400. API returns `query:""`, `rank:0` and `snippet:""` for context-only, nullable range-from as today, existing pagination fields and an additive `filters` object echoing normalized effective filters. `app_mode` without app is 400; trim empty UI fields to absence. Bound filter sizes as above. No changes to default frame browsing or calendar counts; filtering scope is search initially.

Cursor version2 includes normalized filters, query, agent/range/monitor/scope/sort and exact DB rank/time/id position. Continue accepting version1 only as no-context-filter cursors. Omitted continuation filters inherit; explicit changes/clears return 400 and require a new search. Repeat q as today (blank/absent permitted for context-only). Frozen frontend request snapshot includes every filter. Preserve rank/time/id tie order, limit+1 completeness and exact float4 rank serialization. Cursor limits must cover bounded combined filters; never trust cursor agent/role without normal endpoint authorization.

Frozen filters/time bounds are **not** a frozen result set: delayed spools with older captured_at and retention can change later pages. State that completeness refers to matching retained rows at request time. A Refresh starts over; do not promise replay of a database snapshot. A true snapshot would need a separate ingestion watermark/commit model, outside this slice.

## Privacy and UI defaults

Use existing operator/admin Recall read authorization, replay/search audit and retention/deletion paths. Audit normalized filter names/values and mode/scope with existing search access rules; recognize that title searches are sensitive just like existing OCR q. Never log raw context/URLs in capture/ingest error logs, create independent longer retention, or render unescaped text/HTML. Full URL paths remain out of the first milestone.

Default search remains OCR plus all contexts. Put optional app/title/site filters in compact expandable controls. Label app context “Foreground app around capture”; show uncertainty/unknown and legacy no-context honestly. Site filter says “Exact host,” explaining subdomains. Empty results offer clear filters/Refresh; missing context does not imply no browser/app existed. Saved searches/URL state store validated filters under existing server/user/device scope, default old saved searches to all/no filters, and invalidate cursors/results on edit. Grouping must not hide differing observed app/site labels; seek to the hit's existing time/monitor and display that frame's context, never latest activity.

## Implementable slices and tests

1. **Backend additive foundation:** `server/src/ws_agent.rs`, `server/src/db/screen_history.rs`, `server/src/api/screen_history.rs`, `server/src/agent_modules.rs` read-only authorization helper as needed, NEW `server/src/recall_context.rs`, next migration, temporary DB/protocol tests. Validate/persist optional context, scoped dedup, metadata grant checks, filter SQL/cursor2 and response fields. Old agents work; new metadata unavailable until agent slice. Preserve current geometry and lifecycle changes after delegates release ownership.
2. **Agent window vertical slice:** `agent/src/screen_history.rs`, `screen_spool.rs`, `agent_loop.rs`, `permissions/`, `window_tracker.rs`, `platform/{types.rs,windows/mod.rs,linux/activity_tracker.rs}`, NEW `agent/src/recall_context.rs`/platform adapters. Capture-start timing, bounded before/after snapshots, original secondary fences and final-writer redaction. Windows/Hyprland supported; other desktops unknown. Browser status unsupported, no reused activity URLs.
3. **Agent URL extension:** dedicated HWND-rooted bounded Windows UIA provider in NEW `agent/src/recall_context_windows.rs`; reuse reviewed extraction rules from patched browser library only after identity/timeout fixes. Existing activity provider remains separate. Linux URL stays unsupported until an independently designed provider exists. Host-only wire contract requires no schema change.
4. **Frontend:** `frontend/src/lib/{types.ts,api.ts,recallUrl.ts}`, demo API, `components/recall/{RecallSearch.tsx,recallRetrieval.ts,recallSearchGroups.ts}` and tests; frame context label component as needed. Consume API/context filters and saved searches without touching geometry overlay behavior.

Required evidence:

- Agent fixtures: old spool/no context loads; stable/changed/A→B→A limitation documented; timeout/provider error; two windows sharing PID/title; background-monitor relation; independent Recall/window/URL grants; generation revoke/regrant during screenshot, spool write and final network send; delayed upload never resamples or relabels; UTF-8 limits/host normalization.
- Backend protocol fixtures: legacy binary/JSON, missing/unknown/malformed context, invalid modern identity, populated metadata with disabled/stale grant, duplicate same agent first-wins, same UUID other agent accepted, redundant blob cleanup and lifecycle deletion races.
- Temporary PostgreSQL fixtures: NULL retained rows; observed/uncertain/disabled/unknown semantics; exact/prefix literal `%_` app; Unicode title; IDNA/IPv6/localhost/trailing-dot/exact-subdomain host; metadata-only queries; rank/time/id ties, changed/omitted filters, version1/2 cursors and limits; late historical inserts/retention document nonsnapshot behavior.
- DOM tests: old/no-context rows, visible uncertainty, defaults unchanged, context-only search, saved/URL restore and scope isolation, frozen continuation filters, stale response rejection, empty-filter recovery, seek context from selected frame, escaping and no per-row requests.

Use focused agent/server/frontend checks plus disposable fixtures; never apply the migration to the shared DB during development tests. This plan adds capture-associated observations and useful filters, not atomic pixel attribution or a new physical-consent requirement.
