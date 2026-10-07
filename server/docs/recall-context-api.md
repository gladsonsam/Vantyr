# Additive Recall context API

Stage contract, 2026-10-04. Existing Recall operator/admin authorization, audit, retention and image/OCR semantics apply. Context is an observation of session foreground activity around a capture, not atomic attribution of all pixels or proof that an app is visible on the selected monitor. The current agent window slice emits no browser host values; the host-only schema/filter is reserved for the future browser slice.

## Responses

Existing frame lists, frame-at and search hits add:

```json
{
  "capture_duration_ms": 24,
  "context": {
    "version": 1,
    "scope": "session_foreground",
    "bracket_ms": 48,
    "monitor_relation": "unknown",
    "window": {
      "status": "observed",
      "reason": null,
      "source": "win32",
      "app": "Editor.EXE",
      "title": "Documentation"
    },
    "browser": {
      "status": "unknown",
      "reason": "unsupported",
      "source": "none",
      "url": null,
      "url_host": null
    }
  }
}
```

Both new fields are nullable. Old rows remain null; no backfill from event tables. `window.title_truncated:true` is optional. Status enum: `observed|uncertain|unknown|not_collected`; reason enum: `module_disabled|revoked|unsupported|no_foreground|not_browser|read_failed|sample_timeout|changed|identity_unverified|invalid_url|invalid_context`, or null. Window sources: `win32|hyprland|none`; browser: `uia_hwnd|none`. Monitor relation: `unknown|same|other`. Only observed components carry non-null values. API omits ingestion-only `grant_revisions`, HWND/PID/identity/config and unknown fields. Reserved browser `url` is always null.

Context JSON is at most 4 KiB. Capture duration and bracket are integer 0..1000 ms. App is at most 256 UTF-8 bytes (oversize becomes null); title at most 1024 bytes, truncated at a character boundary with a flag. Control characters are removed. A host is canonical IDNA/lowercase, at most 253 bytes, without credentials/path/query/fragment/port. Malformed components lose their own values; a valid sibling and authorized image survive. Unknown versions/malformed envelopes drop context entirely.

Populated window/browser components require their original exact integer grant revision, current originating socket UUID, available/enabled grant without authorization-required or pending stop. Checks run after blob/partition work immediately before INSERT under the existing lifecycle ingestion lease. Stops/lifecycle changes take the writer lease, and one connection processes report/frame messages in order. Historical context already accepted is not erased by later grant changes.

Non-null context-bearing frames require a valid RFC3339 timestamp and UUID UID; invalid identity is a permanent rejected/acked frame, never timestamp fallback. Legacy frames without context preserve compatibility. `(agent_id,captured_at,client_uid)` dedup is first-wins: retries never rewrite metadata/OCR, and redundant blobs are removed. A different agent using the same timestamp/UID is independent.

## Search filters

`GET /api/agents/:id/history/search` adds optional AND filters:

| Parameter | Contract |
| --- | --- |
| `app` | Exact canonical identity by default, ASCII lowercase; no friendly name/path aliases or automatic `.exe` stripping. Maximum 256 bytes. |
| `app_mode` | `exact|prefix`; requires app. Prefix is literal: `%`, `_` and backslash do not become SQL wildcards. |
| `title` | Literal case-insensitive substring, maximum 1024 bytes. Uses deterministic PostgreSQL `C` collation: ASCII case-insensitivity, no promise of Unicode-wide case folding; Unicode literal text is retained. |
| `url_host` | Exact normalized host; no implied subdomains. Accept IDNA/domain, localhost, IPv4 and bracketed/bare IPv6; reject schemes, paths, ports, credentials, query and fragment. |
| `context` | `all` default, `known`, or `unknown`. Known means at least one observed non-null app/title/host; unknown is its complement, including old rows. Unknown plus a value filter is HTTP 400. |

Whitespace-only value filters become absent; other values are trimmed. Invalid type/schema/enums, controls, overlong values, invalid host or app_mode without app return HTTP 400. OCR `q` keeps its existing maximum 4096 bytes and relevance behavior. Blank/omitted q is permitted only with an active context filter: newest order, rank 0 and empty snippet. Explicit `sort=ranked` without OCR is HTTP 400. Unfiltered blank q remains HTTP 400. Existing scope/range/monitor limits still apply; calendar/default frame browsing remains unfiltered.

Search response adds this effective normalized object (including absent/default values):

```json
{
  "query": "",
  "sort": "newest",
  "filters": {
    "app": "editor.exe",
    "app_mode": "exact",
    "title": null,
    "url_host": null,
    "context": "all"
  }
}
```

Cursor v2 contains these filters plus the existing device/query/range/monitor/scope/sort and exact DB rank/time/id position. Omitted continuation filters inherit; an explicitly changed/cleared filter returns HTTP 400. Repeat OCR q as before; omit or send blank q for context-only. Version1 cursors remain accepted only without context filters. All newly issued cursors are v2; cursor length remains capped at 65536 bytes, covering worst-case bounded escaped fields.

Frozen filters/time bounds are not a database snapshot. Delayed spools and retention can change matching retained rows between requests; completeness is evaluated at each request. Refresh restarts retrieval. No hardware, Windows or real browser context capture is verified by server fixtures.
