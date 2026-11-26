//! Public, immutable data types for the filter adapter.
//!
//! Nothing in this module performs I/O or starts a refresh. `ListSource` is a
//! caller-supplied in-memory byte slice: a future subscription layer may fetch
//! bytes and hand them to `compile`, but this crate never fetches them itself.

#[cfg(feature = "abp")]
use crate::limits::MAX_RULE_LEN;
use crate::limits::{MAX_DIAGNOSTIC_LEN, MAX_FIELD_LEN};

/// Which maintained parser owns a source. The formats are intentionally not
/// interchangeable: hosts files carry bare/address-prefixed domains, ABP lists
/// carry domain-anchored network rules.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ListFormat {
    Hosts,
    Abp,
}

/// One bounded, caller-supplied list. `source_url` is optional attribution
/// metadata only; it is never dereferenced and no per-query URL history is
/// retained.
#[derive(Clone, Debug)]
pub struct ListSource<'a> {
    pub id: String,
    pub format: ListFormat,
    pub bytes: &'a [u8],
    pub source_url: Option<String>,
}

/// Immutable provenance recorded for one accepted list.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListMeta {
    pub id: String,
    pub format: ListFormat,
    pub content_sha256: [u8; 32],
    pub byte_len: usize,
    /// Authoritative count from the upstream parser (`entry_count` for
    /// Hickory, accepted rule count for the ABP engine).
    pub accepted_rules: usize,
    pub rejected_rules: usize,
    pub source_url: Option<String>,
}

/// Where a decision's evidence came from.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SourceKind {
    List,
    Service,
}

/// Bounded evidence attached to a decision. `rule` is `None` when the upstream
/// API deliberately does not expose a rule-level match; `note` then states
/// that limitation instead of inventing attribution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Evidence {
    pub source_id: String,
    pub source_kind: SourceKind,
    pub rule: Option<String>,
    pub note: &'static str,
}

/// The only three outcomes this library produces. `AllowException` is a
/// *list-layer* signal: it must never be used to override the household
/// baseline policy owned by the DNS worker.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FilterOutcome {
    Block { evidence: Evidence },
    AllowException { evidence: Evidence },
    NoMatch,
}

/// Bounded, deterministic diagnostic. `Note` entries are retained in a
/// compiled snapshot; all other kinds fail the candidate build.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DiagnosticKind {
    Note,
    Unsupported,
    Malformed,
    EmptySource,
    InvalidEntry,
    Limit(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Diagnostic {
    pub source_id: String,
    pub line: usize,
    pub kind: DiagnosticKind,
    pub detail: String,
}

impl Diagnostic {
    pub fn new(
        source_id: &str,
        line: usize,
        kind: DiagnosticKind,
        detail: impl Into<String>,
    ) -> Self {
        let mut detail = detail.into();
        if detail.len() > MAX_DIAGNOSTIC_LEN {
            detail.truncate(MAX_DIAGNOSTIC_LEN);
        }
        Self {
            source_id: truncate(source_id, MAX_FIELD_LEN),
            line,
            kind,
            detail,
        }
    }
}

/// Why a candidate was not built. The caller keeps its existing snapshot; no
/// automatic swap, no partial coverage.
#[derive(Clone, Debug)]
pub enum CompileError {
    /// A configured bound would be exceeded.
    Limit(String),
    /// Input that cannot be interpreted at all (non-UTF-8, duplicate ids,
    /// invalid service catalog entries).
    InvalidInput(String),
    /// Explicit, bounded diagnostics: at least one rule or source was
    /// unsupported, malformed or empty. No silent weakening is allowed.
    Rejected(Vec<Diagnostic>),
}

impl std::fmt::Display for CompileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Limit(detail) => write!(f, "filter candidate exceeds a bound: {detail}"),
            Self::InvalidInput(detail) => write!(f, "invalid filter candidate: {detail}"),
            Self::Rejected(diags) => {
                write!(
                    f,
                    "filter candidate rejected with {} diagnostic(s)",
                    diags.len()
                )
            }
        }
    }
}

impl std::error::Error for CompileError {}

pub(crate) fn truncate(input: &str, max: usize) -> String {
    if input.len() <= max {
        return input.to_owned();
    }
    let mut end = max;
    while end > 0 && !input.is_char_boundary(end) {
        end -= 1;
    }
    input[..end].to_owned()
}

#[cfg(feature = "abp")]
pub(crate) fn bounded_rule(input: &str) -> Option<String> {
    if input.is_empty() {
        None
    } else {
        Some(truncate(input, MAX_RULE_LEN))
    }
}
