# Network filtering: list compilation contract

This document records the boundary of the `vantyr-network-filter` library. It
is a compilation contract, not an enforcement or subscription design. Worker
integration and remote refresh are separate, later increments.

## Scope

The library accepts caller-supplied raw bytes and produces an immutable
`FilterSnapshot`. It performs no I/O, owns no HTTP client and starts no fetch.
A caller may hold the snapshot in an `Arc` and replace it only after a
successful build.

Inputs:

- list sources: `(id, format, bytes, optional source_url)`;
- an optional operator-provided service catalog with selected service ids;
- explicit resource `Limits`.

Output: `Ok(FilterSnapshot)` with revision, per-list content SHA-256, byte
counts, authoritative upstream rule counts, provenance and bounded diagnostics,
or `Err(CompileError)` with bounded diagnostics. A failed build never changes
caller-held state.

## Maintained backends

- hosts / bare domain / leading-wildcard sources: Hickory 0.26.4 blocklist
  (`add(Read)`, `entry_count()`, `ZoneHandler::lookup()`). Matching stays in
  Hickory; the adapter only normalises non-`0.0.0.0` address prefixes and drops
  `localhost`.
- DNS-representable ABP domain rules: `adblock` 0.13.6 (Brave `adblock-rust`,
  MPL-2.0), `debug-info` feature only. Precedence is read from upstream
  `BlockerResult`; a minimal synthetic hostname carrier is documented in the
  crate README.

Both library names and licences are preserved in the crate README.

## Capability status

Supported now: exact/suffix hosts entries, leading wildcards with a minimum
depth, IDNA/case/trailing-dot canonicalisation via Hickory, `||host^`,
`@@||host^`, `$important`, and operator-provided exact/suffix service domain
sets with service-id evidence.

Not supported (explicit diagnostics, not silent acceptance): regex rules
(**MISSING**, needs a maintained regex parser in a later step), paths, URLs,
scheme-specific rules, `$third-party`, content-type modifiers, query-type
modifiers such as `$dns`, cosmetic rules, redirect/CSP/removeparam options and
unanchored patterns. Query types other than A/AAAA/CNAME return `NoMatch`.

Overall status: **Partial**. This library implements a bounded subset and does
not claim complete coverage of all rule syntax.

## Service catalogs

Services are domain sets with ids, labels, versions and optional source and
evidence metadata. They are compiled through the same Hickory parser/evaluator
as hosts lists. Service IDs are returned as evidence on a block. No app
identity, full URL or browser-category matcher is modelled. Only synthetic
fixtures exist in-tree; a real catalog needs a verified source and licence.

## Safety boundary

`AllowException` is a list-layer outcome. It never overrides the household
baseline policy owned by the DNS worker. Ambiguous, context-dependent rules
cannot grant an allow: they are rejected with diagnostics. Non-UTF-8 bytes,
duplicate ids, empty or fully malformed sources and invalid catalog entries
fail the whole candidate.

## Follow-up ownership

- Subscription/refresh layer: fetch raw bytes, apply byte/count bounds, call
  `compile_with_limits`; keep fetching out of this crate.
- DNS worker: hold the snapshot in an `Arc`, evaluate explicit query types and
  keep household policy authoritative; integrate only after this library is
  accepted.
