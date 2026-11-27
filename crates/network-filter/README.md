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
| bounded hostname regex rules | `regex` 1.13.2 (<https://github.com/rust-lang/regex>) | MIT OR Apache-2.0 | `RegexBuilder` with explicit compile/DFA/nesting bounds; `is_match` on the canonical host |

Only `adblock`'s `debug-info` feature is enabled (needed for rule/source
evidence). `embedded-domain-resolver`, `single-thread` and `full-regex-handling`
are off: hostname regex rules are compiled by the bounded automata engine in
this crate instead, and the ABP engine must stay `Sync` for an `Arc` snapshot
swap. The `abp` feature is on by default, enables both upstreams above and can
be disabled by callers that only need Hickory hosts lists.

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

Hosts-source IDNA canonicalisation remains supported. For hostname regex rules,
write IDN patterns in punycode: the matched host is the canonical ASCII form.


Accepted, after an explicit DNS-representability guard **and** upstream parsing:

- `||host^` — domain-anchored block, matching that host and its subdomains;
- `@@||host^` — exception, yielding `AllowException` inside the list layer;
- `||host^$important` — upstream `$important` precedence, read from
  `BlockerResult` (an important block beats an ordinary exception);
- `@@||host^$important` — important domain exception. Upstream reports this in
  the exception result rather than its `important` flag; the raw rule metadata
  is read so it outranks important blocks from either rule family. An ordinary
  block must also match for upstream to report the exception;
- `/regexp/`, `@@/regexp/`, `/regexp/$important` — hostname regex rules. These
  match the canonical host directly (ASCII lowercase, punycode for IDN, no
  trailing dot). Patterns are case-insensitive, `^`/`$` anchor the whole
  hostname and an unanchored pattern matches anywhere in it. Regex rules never
  see a URL, scheme, path or trailing slash. An orphan `@@` regex exception
  still yields the list-layer `AllowException` signal;
- escaped slashes (`\/`) are accepted inside a regex body. Every pattern is
  bounded in text length, compiled-program size, DFA size and nesting depth.

Upstream domain-rule matching needs a request-shaped value. A minimal synthetic
`http://<canonical-host>/` carrier is built **only** to carry the queried
hostname into that engine. Regex rules do not use it. No path, scheme, source
URL, third-party state or content-type semantics are derived from it, and none
are exposed to callers.

Rejected with a bounded diagnostic (never silently matched):

- regex modifiers other than `important`, and important regex exceptions
  (`@@/regexp/$important`), which would need to override important blocks;
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

#### Typed `$dnsrewrite` (first slice, compiler only)

The maintained `adblock` 0.13.6 engine exposes no typed DNS rewrite, so this
first slice uses a thin bounded parser instead of inventing an upstream
meaning. It accepts only:

- `||host^$dnsrewrite=NOERROR;A;192.0.2.1` and the IPv4 shorthand
  `||host^$dnsrewrite=192.0.2.1` -> typed A;
- `||host^$dnsrewrite=NOERROR;AAAA;2001:db8::1` and the IPv6 shorthand
  `||host^$dnsrewrite=2001:db8::1` -> typed AAAA;
- `||host^$dnsrewrite=NOERROR;CNAME;target.example` and the hostname shorthand
  `||host^$dnsrewrite=target.example` -> typed CNAME.

`||host^` has the documented domain-and-subdomain meaning: it matches that
owner and every subdomain at a label boundary, never a lookalike such as
`notexample.com`. Owners and CNAME targets go through the same Hickory
canonicalisation as other list names (ASCII/punycode, lowercase, no trailing
dot), and single-label owners are rejected as too broad. The shorthand keyword
and full-form response codes (`REFUSED`, `NXDOMAIN`, ...), `NOERROR;;`, other
RR types (MX/TXT/PTR/SRV/SVCB/HTTPS/...), wrong type/value pairs, combined
modifiers (`client`, `ctag`, `dnstype`, `important`, `badfilter`, ...), rewrite
exceptions (`@@...$dnsrewrite`), wildcards and one-delimiter values are all
diagnosed explicitly; none is silently matched or turned into a block.

Accepted rewrites never enter the block engines: a rewrite rule alone yields
`NoMatch` from `evaluate`. `FilterSnapshot::select_dns_rewrite(qname)` returns
an immutable `DnsRewriteSelection`, or `None` when no owner matched or a list
exception suppressed it. The selection carries the most specific matching
owner and every distinct typed record for it, in deterministic
`(source id, line)` order with per-record evidence and line. Calling
`DnsRewriteSelection::records_for(qtype)` shapes that set: `A`, `AAAA` and
`CNAME` keep only records of that type, `ANY` keeps every distinct record
(operator-rewrite semantics), and an unsupported query type returns
`DnsRewriteRecords::MatchedEmpty` (NODATA). A matched owner with no record of
the requested type is therefore explicit and never an ordinary fallback for
an unmatched owner. Conflicting CNAME-vs-address or multiple distinct CNAME
values for one owner reject the candidate at compile time. An ordinary
`@@||host^` list exception (including `$important`) suppresses a rewrite for
that owner and its subdomains without granting an allow against household
policy. This is a **compiler-only typed contract**: no DNS response is built,
nothing is enforced at runtime, and no capability row is accepted by this
slice.

### Services

A `ServiceCatalog` is operator-provided and holds **domain sets only**:
`ServiceID`, label, exact/suffix domain rules, version, optional source and
optional evidence. Selected services are compiled through the *same* Hickory
parser/evaluator as hosts lists and return service-id evidence. They are not
app identities, full URLs, or browser-category matchers; no category matcher is
faked onto DNS. The test fixtures are synthetic. **No exhaustive popular-service
catalog is bundled**; adding one requires a verified source and licence.

## Evaluation contract

Query types are explicit for `evaluate`: only `A`, `AAAA` and `CNAME` are
evaluated; every other record type returns `NoMatch`. The separate rewrite
selection additionally accepts `ANY` as operator-rewrite query semantics and
returns matched-empty (NODATA) for an unsupported query type on a matched
owner; neither behaviour changes any `evaluate` outcome.

Deterministic precedence (highest first):

1. `@@||host^$important` domain exception -> `AllowException`;
2. `$important` block from an ABP source (domain rule or hostname regex);
3. a selected service domain set (lexicographically first id on overlap);
4. an ordinary `@@` exception from an ABP source (domain rule or hostname
   regex) -> `AllowException`;
5. a plain ABP block (domain rule or hostname regex);
6. a hosts/bare/wildcard list block (lexicographically first id);
7. `NoMatch`.

Within one ABP source, important blocks outrank ordinary exceptions, which
outrank plain blocks. Regex rules use the same ranking as upstream domain
rules; on an equal rank the domain rule's evidence is kept. The one additional
rank is the important domain exception, which outranks every block (including
a regex important block) so domain important-exception semantics stay
consistent across both source orders. Important regex exceptions are explicitly
diagnosed instead of being silently weakened. A service block always outranks
an ordinary exception.

`AllowException` is strictly a **list-layer** outcome. It must never be used
to override the household baseline policy owned by the DNS worker. This crate
never sees that policy and makes no such claim. Typed rewrites are selected
through the separate `select_dns_rewrite(qname)` plus `records_for(qtype)`
calls only; they do not change any `evaluate` outcome or block precedence
above.

Evidence is honest about upstream limits: Hickory's blocklist API does not
expose the matched entry, so hosts/service decisions carry only list or service
id attribution. ABP domain decisions carry the upstream-reported rule, bounded and
mapped to its source index. Hostname regex decisions carry the exact rule text
and its own source id and line, independent of upstream debug information.

## Bounds and failure behaviour

Defaults: 8 MiB aggregate raw bytes, at most 32 lists, 250 000 accepted rules,
at most 64 retained diagnostics, 64 services, 512 domains per service, and an
additional global cap of 512 accepted typed DNS rewrites across all sources.
Accepted rewrites, duplicates included, count toward `total_rules`; the cap is
charged globally before publication and an overflow rejects the whole
candidate with a bounded `Limit` diagnostic. An exact-at-cap candidate is
accepted. At publication, duplicates collapse to one record per distinct
value per owner in `(source id, line)` order. Owner selection walks only
label boundaries and bounded owner index lookups, never a scan of every rule
per query. Counts, source material hashes and every `evaluate` decision are
unchanged by rewrite selection. `compile_with_limits` lets callers lower the
general bounds.

Each hostname regex pattern is bounded to 200 bytes of text, 256 KiB of
compiled program, 256 KiB of DFA cache and 32 levels of nesting. Because every
regex rule is tested on each supported query and the general `max_rules` bound
(250 000) is far too loose for linear regex scanning, three additional limits
are charged **globally across all ABP sources**, before any pattern is
compiled:

| Bound | Default | What it charges |
| --- | --- | --- |
| `max_regex_rules` | 512 | one per accepted regex pattern; caps the per-query scan length |
| `max_regex_work_bytes` | 64 KiB | each pattern's text length, a proxy for per-query match work |
| `max_regex_reservation_bytes` | 256 MiB | 512 KiB per pattern (full program allowance + full DFA allowance) |

Exceeding any of them rejects the **entire** candidate with a bounded
`DiagnosticKind::Limit` diagnostic (the oldest retained diagnostic is dropped
to make room), not just the offending rule. The budget is checked before
compilation so splitting adversarial patterns across many sources cannot spend
unbounded compile work. An exact-at-budget candidate is accepted.

The reservation is an accounting value, not a process-memory guarantee. The
`regex` automata engine keeps its own lazily allocated DFA caches, and both
engines allocate additional thread-local caches or use a mutex-protected regex
manager under concurrent matching. Those engine cache and concurrency limits
are unavoidable through these APIs, so **no strict process RSS bound is
claimed**.

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
- DNS worker integration and enforcement, including typed rewrite response
  construction and ordering against household policy (the compiler slice above
  makes no runtime or capability claim);
- full ABP syntax, further modifiers and context-dependent rule selection;
  response-code rewrites, suppression forms and RR types beyond A/AAAA/CNAME;
- exhaustive service catalogs and live feeds.

## Tests

    cargo test
    cargo clippy --all-targets -- -D warnings
    cargo check --no-default-features
