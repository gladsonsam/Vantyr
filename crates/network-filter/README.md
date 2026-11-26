# vantyr-network-filter

A **bounded, immutable filter-list foundation** for Vantyr DNS. It turns
caller-supplied in-memory bytes into a `FilterSnapshot` that a worker can hold
in an `Arc` and swap only after a successful build.

This crate does **no** network I/O. There is no fetcher, no HTTP client, no
remote subscription and no enforcement path. A future subscription layer owns
fetching and passes raw bytes to `compile`; this library only validates and
compiles them.

## Maintained upstreams and attribution

| Concern | Upstream | License | What is used |
| --- | --- | --- | --- |
| hosts / bare / wildcard domain lists | Hickory `hickory-server` 0.26.4 | MIT OR Apache-2.0 | `store::blocklist::BlocklistZoneHandler::add(Read)`, `entry_count()`, public `ZoneHandler::lookup()` |
| DNS-representable ABP domain rules | `adblock` 0.13.6 (Brave `adblock-rust`, <https://github.com/brave/adblock-rust>) | **MPL-2.0** | `FilterSet`, `Engine`, public `NetworkFilterMask`/metadata, `BlockerResult` precedence |

Only `adblock`'s `debug-info` feature is enabled (needed for rule/source
evidence). `embedded-domain-resolver`, `single-thread` and `full-regex-handling`
are off: we reject every regex rule, and the engine must stay `Sync` for an
`Arc` snapshot swap. The `abp` feature is on by default and can be disabled by
callers that only need Hickory hosts lists.

No DNS wire format, cryptography, or full adblock syntax compiler is
implemented here.

## Supported syntax (a bounded Partial subset)

### Hosts source (`ListFormat::Hosts`)

- bare domain (`example.com`) — exact fully-qualified match;
- `0.0.0.0 example.com` — Hickory handles this form natively;
- other address prefixes (`127.0.0.1`, `::1`, IPv4/IPv6) — normalised to bare
  domain lines before Hickory parses them; the address itself is never used;
- one leading wildcard (`*.example.com`) — Hickory expands it; its
  `min_wildcard_depth = 2` rejects broad entries such as `*.com`;
- `#` comments and `!` comments; `localhost` / `localhost.localdomain` ignored;
- case, trailing dot and IDNA canonicalisation come from Hickory's `Name`.

### ABP source (`ListFormat::Abp`, feature `abp`)

Accepted, after an explicit DNS-representability guard **and** upstream parsing:

- `||host^` — domain-anchored block, matching that host and its subdomains;
- `@@||host^` — exception, yielding `AllowException` inside the list layer;
- `||host^$important` — upstream `$important` precedence, read from
  `BlockerResult` (an important block beats an exception).

Upstream matching needs a request-shaped value. A minimal synthetic
`http://<canonical-host>/` carrier is built **only** to carry the queried
hostname. No path, scheme, source URL, third-party state or content-type
semantics are derived from it, and none are exposed to callers.

Rejected with a bounded diagnostic (never silently matched):

- regex rules (including `/.../`) — **Regex support: MISSING**; a separate
  step would need a maintained regex parser;
- paths and URLs (`||host/path`, `http://`, `https://`);
- cosmetic / element-hiding rules (`##`, `#@#`, `$$`);
- every `$` option except `important` — including `$third-party`,
  `$script`/content-type options, `$domain`, `$~domain`, `$redirect`, `$csp`,
  `$removeparam`, `$match-case`, `$badfilter`;
- query-type-looking modifiers such as `$dns` — these are **not** upstream ABP
  semantics and are not accepted with a different invented meaning;
- unanchored/bare patterns (ambiguous substring matches), single-label domains,
  wildcard characters in ABP rules (use a hosts source instead).

An orphan `@@` exception must be accompanied by a matching block rule for
upstream to report it. Diagnostics say so; nothing is fabricated.

### Services

A `ServiceCatalog` is operator-provided and holds **domain sets only**:
`ServiceID`, label, exact/suffix domain rules, version, optional source and
optional evidence. Selected services are compiled through the *same* Hickory
parser/evaluator as hosts lists and return service-id evidence. They are not
app identities, full URLs, or browser-category matchers; no category matcher is
faked onto DNS. The test fixtures are synthetic. **No exhaustive popular-service
catalog is bundled**; adding one requires a verified source and licence.

## Evaluation contract

Query types are explicit: only `A`, `AAAA` and `CNAME` are evaluated; every
other record type returns `NoMatch`.

Deterministic precedence (highest first):

1. upstream `$important` block from an ABP source;
2. a selected service domain set (lexicographically first id on overlap);
3. upstream `@@` exception -> `AllowException`;
4. a plain ABP block;
5. a hosts/bare/wildcard list block (lexicographically first id);
6. `NoMatch`.

`AllowException` is strictly a **list-layer** outcome. It must never be used
to override the household baseline policy owned by the DNS worker. This crate
never sees that policy and makes no such claim.

Evidence is honest about upstream limits: Hickory's blocklist API does not
expose the matched entry, so hosts/service decisions carry only list or service
id attribution. ABP decisions carry the upstream-reported rule, bounded and
mapped to its source index.

## Bounds and failure behaviour

Defaults: 8 MiB aggregate raw bytes, at most 32 lists, 250 000 accepted rules,
at most 64 retained diagnostics, 64 services, 512 domains per service.
`compile_with_limits` lets callers lower every bound.

`compile` is pure: it returns `Result`. Any non-`Note` diagnostic (unsupported
rule, malformed/empty source, invalid catalog entry) or exceeded bound rejects
the **whole** candidate. The caller keeps its previous `Arc` — there is no
automatic swap and no partially compiled list.

Raw source bytes must be UTF-8; `source_url` is optional attribution metadata
only, never dereferenced, and no per-query URL history is retained.

## Contract for a future subscription/fetch layer

`compile_with_limits(revision, &[ListSource { id, format, bytes, source_url }],
catalog, selected_service_ids, &limits) -> Result<FilterSnapshot, CompileError>`
is the whole interface: a raw-bytes validator function is sufficient. Do not
couple fetching or HTTP dependencies into this crate. Fetch, bound the bytes,
then call `compile`; publish the resulting snapshot only on `Ok`.

## Deferred / not claimed

- remote HTTP/S subscription refresh and local content-addressed durability;
- DNS worker integration and enforcement;
- regex rules, full ABP syntax, and query-type-specific modifiers;
- exhaustive service catalogs and live feeds.

## Tests

    cargo test
    cargo clippy --all-targets -- -D warnings
    cargo check --no-default-features
