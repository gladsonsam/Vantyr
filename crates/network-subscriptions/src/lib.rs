//! Bounded, SSRF-safe subscriptions to **public** HTTPS DNS-list URLs.
//!
//! This crate is deliberately independent of the filter/DNS workers. It knows
//! nothing about DNS parsing or household policy: the only link to a consumer
//! is [`CandidateValidator`], a compile callback supplied by the caller. Bytes
//! are promoted to last-known-good **only** after that callback accepts them.
//!
//! # Scope (first slice)
//!
//! * Public HTTPS URLs only. No credentials, no userinfo, no fragments, no
//!   query by default (an explicit, public-only query allowlist is possible).
//! * `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>` is an ordinary
//!   HTTPS URL. `github.com/.../blob/...` is an HTML viewer page and is
//!   rejected with a diagnostic rather than being mistaken for a list.
//! * Every socket address actually used is vetted as a public global address
//!   before it is handed to reqwest via its maintained resolver seam. TLS
//!   still verifies the **original hostname**; there is no TOCTOU rebind and
//!   no hand-rolled TLS. Redirects are disabled (reported, never followed).
//! * One atomic JSON snapshot per list holds metadata + validated bytes +
//!   SHA-256. On any fetch/TLS/HTTP/parse/write failure the previous
//!   last-known-good file and in-memory state stay unchanged.
//! * Conditional GET (`If-None-Match` / `If-Modified-Since`), bounded 304
//!   handling, `Retry-After` for 429/503 with bounded exponential backoff and
//!   jitter, configurable interval (5 min .. 7 days, default 24 h), manual
//!   refresh, explicit enable/disable, and truthful
//!   [`SubscriptionStatus`] reporting.
//!
//! There is no daemon HTTP API, no UI and no "safe" badge. This crate does not
//! bundle or fetch any third-party list on its own: the operator supplies the
//! URLs and asserts the source/filter licence in required source metadata.
//!
//! Integration with the compiler and the DNS worker is a **next** step. This
//! crate only stores validated bytes; it does not claim to deliver filtering
//! to a household yet.

pub mod backoff;
pub mod cache;
pub mod clock;
pub mod config;
pub mod error;
pub mod fetcher;
pub mod resolve;
pub mod scheduler;
pub mod status;
pub mod transport;
pub mod url;
pub mod validate;
pub mod worker;

// Test-only loopback helpers. There is no feature flag that relaxes TLS or
// SSRF policy in a normal build, and no "danger" constructor flag.
#[cfg(test)]
pub mod test_support;

#[cfg(test)]
mod tests;

pub use config::{Limits, QueryPolicy, SourceMetadata, SubscriptionConfig, SubscriptionSource};
pub use error::Error;
pub use fetcher::{FetchOutcome, Fetcher};
pub use status::{SubscriptionReport, SubscriptionStatus};
pub use url::ValidatedUrl;
pub use validate::{CandidateValidator, CompilationSummary, ValidationError};
pub use worker::{SubscriptionWorker, WorkerHandle};
