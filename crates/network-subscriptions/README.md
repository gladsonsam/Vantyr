# vantyr-network-subscriptions

Bounded, SSRF-safe subscriptions to **public HTTPS** DNS-list URLs. This crate
fetches raw bytes, validates them through a caller-supplied compile callback,
and keeps one atomic last-known-good snapshot per list on local disk.

It is independent of the DNS filter, proxy, server and frontend. It does not
parse DNS lists, enforce household policy, or claim to deliver filtering to a
household. Wiring the validated bytes into a compiler and a DNS worker is a
**next** step.

## What it does

- HTTPS-only public URLs. No userinfo, no fragments, no query by default (an
  explicit, public-only query key allowlist is available). `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`
  is an ordinary HTTPS file URL. `github.com/.../blob/...` is an HTML viewer and
  is rejected with a diagnostic, not parsed as a list.
- Every address used for a connection is vetted as a public global unicast IP
  (loopback, private, link-local, metadata, CGNAT, mapped/non-public, NAT64 and
  reserved ranges are rejected). Addresses are returned directly to reqwest's
  maintained `Resolve` seam, so there is no second DNS lookup and no rebinding
  TOCTOU; TLS still verifies the original hostname. Redirects are disabled and
  reported, never followed.
- Conditional GET with `If-None-Match` / `If-Modified-Since`. A 304 updates only
  `checked_at`; content bytes, digest, `fetched_at` and the source's
  `Last-Modified` are preserved.
- `Retry-After` on 429/503 with bounded exponential backoff and injected RNG
  jitter. Forced refresh ignores the normal due time but never an abuse
  cooldown. No tight fetch loop.
- One JSON snapshot file per list (0600, symlink-refusing read with `O_NOFOLLOW`,
  temp-file + fsync + atomic rename, best-effort parent directory sync). The
  content, digest and metadata are in the same file, so they cannot disagree.
  A corrupt/oversize/wrong-URL cache entry is an error, never an empty fallback.
- On fetch, TLS, HTTP, validation or write failure the previous last-good bytes
  and on-disk file are untouched. A restart reloads the validated cache and
  never freshens content timestamps.
- Truthful status: `NeverFetched`, `Fresh`, `Stale`, `Disabled`,
  `FailedWithLastGood`; plus failure counts, stale flag, next due time and
  cooldown. There is no "safe" badge and no UI/daemon HTTP API in this slice.

## Public API

```rust,ignore
use vantyr_network_subscriptions::{
    CandidateValidator, CompilationSummary, FetchOutcome, Fetcher,
    SubscriptionConfig, SubscriptionStatus, ValidationError,
};

// The compile callback is supplied by the filter/compiler owner. This crate
// never parses the list and promotes bytes only when this returns Ok.
fn compile(bytes: &[u8]) -> Result<CompilationSummary, ValidationError> {
    // ... real compilation here ...
    Ok(CompilationSummary { rule_count: 1 })
}

let config: SubscriptionConfig = /* from operator configuration */;
let fetcher = Fetcher::new("./cache", &config, compile)?;

let outcome = fetcher.refresh("public-blocklist", false).await?;
let report = fetcher.status("public-blocklist")?;
let bytes = fetcher.last_good_bytes("public-blocklist")?;
```

- `Fetcher::new` builds the production reqwest client. `with_transport` is a
  dependency-injection seam for embedding/tests; `with_timing` injects clock
  and RNG for deterministic scheduling tests. Neither relaxes TLS, SSRF or
  promotion rules.
- `refresh(id, force)`, `refresh_all(force)`, `status(id)`, `status_all()`,
  `last_good_bytes(id)`, `set_enabled(id, bool)`.
- `SubscriptionWorker::new(Arc::clone(&fetcher), limits)` +
  `WorkerHandle::{request_refresh, shutdown}` provide bounded periodic refresh
  (concurrency capped by `max_concurrency`); no network-facing daemon is
  required.

## Configuration example

```json
{
  "sources": [
    {
      "id": "public-ads",
      "url": "https://raw.githubusercontent.com/example/repo/main/lists/ads.txt",
      "enabled": true,
      "interval_secs": 86400,
      "max_stale_secs": 259200,
      "metadata": {
        "title": "Public advertising hosts",
        "publisher": "Example publisher",
        "license": "operator-approved"
      }
    }
  ],
  "limits": { "max_concurrency": 4 },
  "query_policy": "reject"
}
```

`limits` and `query_policy` are optional (`Default` is used). The metadata
fields are required and non-empty: the operator asserts the right to fetch and
use each source. This crate does not bundle or auto-fetch any stock list, and
does not decide that a licence exists.

## Bounds and defaults

| Setting | Default | Hard bound |
| --- | --- | --- |
| configured sources | — | 32 |
| candidate bytes per list | 8 MiB | <= 8 MiB |
| aggregate cached bytes | 8 MiB | <= 8 MiB |
| snapshot file | 16 MiB | <= 16 MiB |
| conditional/cache header | 512 B | <= 512 B |
| parser diagnostic | 2048 B | <= 2048 B |
| connect timeout | 10 s | 1..=3600 s |
| request timeout (whole body) | 60 s | 1..=3600 s |
| pull interval | 24 h | 5 min .. 7 days |
| `max_stale` | 72 h | 1 h .. 7 days |
| concurrency | 4 | 1..=32 |
| `Retry-After` | capped | <= 24 h |
| backoff | 60 s doubling | <= 7 days |

All bounds are checked before any socket is opened. Source ids are restricted
to `[A-Za-z0-9_-]` and at most 64 characters so they are safe cache filenames.

## Deliberate non-goals / open limits

- No DNS-list parser, no household `Policy` types: the compile callback is the
  only integration point.
- No redirects, no authentication, no arbitrary hosts from an untrusted input:
  sources are explicit operator configuration.
- No normalization of arbitrary GitHub links into raw URLs (no safe guess).
  Operators supply the raw file URL themselves.
- No daemon HTTP API, UI, or "safe" status badge in this slice.
- Cache trust is single-process. The parent directory must not be
  world-writable; cross-process locking is out of scope.
- Conditional-request and rate-limit behaviour follows the HTTP semantics used
  by reqwest; no third-party list or API key is bundled or sent.

## Tests

`cargo test -p vantyr-network-subscriptions` (18 tests). They include a real
TLS loopback server with an in-test generated CA verified by reqwest (no
`danger_*` switches), covering 200 → conditional 304 → changed content →
empty/malformed content retaining last-good, 429 cooldown, offline restart,
oversized/chunk-stalled bodies, wrong CA, private-address and redirect blocking
before any origin socket, deterministic backoff/scheduler clocks, cache file
atomicity/permissions/symlink/URL-identity, and concurrent same-id refresh.

Workspace membership is added by the root `Cargo.toml` owner; this crate alone
does not modify the workspace manifest or `Cargo.lock`.
