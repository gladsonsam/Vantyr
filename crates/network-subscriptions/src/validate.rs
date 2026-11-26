//! The only seam between this crate and a filter/compiler. We deliberately do
//! not parse DNS lists here: the caller supplies a compile callback and the
//! fetcher promotes bytes to last-known-good only after it succeeds.

use serde::{Deserialize, Serialize};

/// Deliberately small: the fetcher only needs to know that a candidate
/// compiled and how many rules it produced. It does not interpret the rules.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct CompilationSummary {
    pub rule_count: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidationError {
    /// Bounded by the configured parser-diagnostic limit before it is stored
    /// or reported.
    pub detail: String,
}

impl ValidationError {
    pub fn new(detail: impl Into<String>) -> Self {
        Self {
            detail: detail.into(),
        }
    }
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.detail)
    }
}

impl std::error::Error for ValidationError {}

pub trait CandidateValidator: Send + Sync {
    fn validate(&self, bytes: &[u8]) -> Result<CompilationSummary, ValidationError>;
}

impl<F> CandidateValidator for F
where
    F: Fn(&[u8]) -> Result<CompilationSummary, ValidationError> + Send + Sync,
{
    fn validate(&self, bytes: &[u8]) -> Result<CompilationSummary, ValidationError> {
        self(bytes)
    }
}
