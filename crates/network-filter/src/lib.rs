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
//! * DNS-representable ABP domain rules (`||host^`, `@@||host^`, `$important`)
//!   -> `adblock` 0.13.6 (Brave `adblock-rust`, MPL-2.0), feature `abp`.
//!   A minimal synthetic `http://<canonical-host>/` carrier is used only to
//!   satisfy upstream's request-shaped matcher. Path, URL, scheme,
//!   third-party, content-type, cosmetic and regex rules are rejected with
//!   diagnostics; no HTTP context semantics are claimed.
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
//! Hickory (https://hickory-dns.org), MIT OR Apache-2.0.

mod canonical;
mod hosts;
mod limits;
mod service;
mod snapshot;
mod types;

#[cfg(feature = "abp")]
mod abp;

pub use limits::{
    Limits, MAX_DIAGNOSTICS, MAX_DIAGNOSTIC_LEN, MAX_DOMAINS_PER_SERVICE, MAX_FIELD_LEN,
    MAX_HOSTS_PER_LINE, MAX_LISTS, MAX_NAME_LEN, MAX_RULES, MAX_RULE_LEN, MAX_SERVICES,
    MAX_TOTAL_SOURCE_BYTES,
};
pub use service::{ServiceCatalog, ServiceDefinition, ServiceDomain, ServiceMeta};
pub use snapshot::{compile, compile_with_limits, FilterSnapshot};
pub use types::{
    CompileError, Diagnostic, DiagnosticKind, Evidence, FilterOutcome, ListFormat, ListMeta,
    ListSource, SourceKind,
};
