//! Bounded, immutable filter-list foundation for Vantyr DNS.
//!
//! This crate builds a `FilterSnapshot` from caller-supplied in-memory bytes.
//! It does no I/O, has no fetcher, no remote subscription and no HTTP client;
//! it does not enforce anything by itself. A DNS worker can hold the snapshot
//! in an `Arc` and swap it only after a successful build.
//!
//! Two maintained upstream parsers/matchers are used, with no hand-written DNS
//! wire code, crypto, or full adblock syntax compiler:
//!
//! * hosts / bare domain / leading-wildcard rules -> Hickory 0.26.4
//!   `BlocklistZoneHandler::add(Read)`, `entry_count()` and the public
//!   `ZoneHandler::lookup()` matcher. The upstream API does not expose the
//!   matched entry, so evidence is per-list and says so honestly.
//! * DNS-representable ABP domain rules (`||host^`, `@@||host^`, `$important`,
//!   `@@||host^$important`) -> `adblock` 0.13.6 (Brave `adblock-rust`, MPL-2.0),
//!   feature `abp`. Important domain exceptions are read from the upstream
//!   exception metadata and outrank blocks from every rule family.
//!   A minimal synthetic `http://<canonical-host>/` carrier is used only to
//!   satisfy upstream's request-shaped matcher. Path, URL, scheme,
//!   third-party, content-type and cosmetic rules are rejected with
//!   diagnostics; no HTTP context semantics are claimed.
//! * bounded hostname regex rules (`/regex/`, `@@/regex/`, `/regex/$important`)
//!   -> `regex` 1.13.2 (MIT OR Apache-2.0), feature `abp`. These match the
//!   canonical hostname directly, with explicit compile-size, DFA-size and
//!   nesting bounds. No synthetic URL is ever used for them. Regex rules also
//!   share a global count/work/reservation budget charged across all sources
//!   before compilation; the automata engines keep their own lazily allocated
//!   and partly thread-local caches, so no strict process RSS bound is claimed.
//! * typed first-slice `$dnsrewrite` rules (typed `NOERROR` A/AAAA/CNAME and
//!   shorthand IP/hostname forms) -> a thin bounded parser in this crate,
//!   feature `abp`. The maintained adblock 0.13.6 engine exposes no typed DNS
//!   rewrite, so these rules are compiled here and never enter the block
//!   engine. They produce immutable typed record sets held in an owner index;
//!   selection is by most specific owner, then shaped per query type. This is
//!   a compiler-only slice: it builds no DNS response, enforces nothing at
//!   runtime and does not close a capability row. A later thin worker
//!   integration owns response construction and ordering against policy.
//!
//! A small typed `ServiceCatalog` maps operator-selected service ids to exact
//! and suffix domain sets. Services are compiled through the same Hickory
//! parser/evaluator and return service-id evidence. They are domain sets only:
//! no app identity, no full URLs, no browser-category matcher. The bundled
//! test fixtures are synthetic; no exhaustive popular-service catalog is
//! shipped.
//!
//! Supported query types are A, AAAA and CNAME. Every other record type gets
//! `NoMatch`. `AllowException` is a list-layer signal and must never be used
//! to override the household baseline policy owned by the DNS worker.
//!
//! Attribution: `adblock` (https://github.com/brave/adblock-rust), MPL-2.0;
//! Hickory (https://hickory-dns.org), MIT OR Apache-2.0;
//! `regex` (https://github.com/rust-lang/regex), MIT OR Apache-2.0.

mod canonical;
mod hosts;
mod limits;
mod service;
mod snapshot;
mod types;

#[cfg(feature = "abp")]
mod abp;
#[cfg(feature = "abp")]
mod dns_rewrite;
#[cfg(feature = "abp")]
mod hostname_regex;

pub use limits::{
    Limits, MAX_DIAGNOSTICS, MAX_DIAGNOSTIC_LEN, MAX_DNS_REWRITES, MAX_DOMAINS_PER_SERVICE,
    MAX_FIELD_LEN, MAX_HOSTS_PER_LINE, MAX_LISTS, MAX_NAME_LEN, MAX_REGEX_DFA_BYTES,
    MAX_REGEX_NEST, MAX_REGEX_PATTERN_LEN, MAX_REGEX_PROGRAM_BYTES, MAX_REGEX_RESERVATION_BYTES,
    MAX_REGEX_RULES, MAX_REGEX_WORK_BYTES, MAX_RULES, MAX_RULE_LEN, MAX_SERVICES,
    MAX_TOTAL_SOURCE_BYTES, REGEX_RESERVATION_PER_RULE,
};
#[cfg(feature = "abp")]
pub use dns_rewrite::{
    DnsRewrite, DnsRewriteRecords, DnsRewriteSelection, DnsRewriteValue,
};
pub use service::{ServiceCatalog, ServiceDefinition, ServiceDomain, ServiceMeta};
pub use snapshot::{compile, compile_with_limits, FilterSnapshot};
pub use types::{
    CompileError, Diagnostic, DiagnosticKind, Evidence, FilterOutcome, ListFormat, ListMeta,
    ListSource, SourceKind,
};
