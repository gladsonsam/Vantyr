//! Explicit resource bounds. All bounds are caller-visible and can be lowered
//! in tests or by a future fetch layer; the defaults are deliberately small.

/// Aggregate raw bytes accepted across all list sources (8 MiB).
pub const MAX_TOTAL_SOURCE_BYTES: usize = 8 * 1024 * 1024;
/// Maximum number of list sources in one candidate snapshot.
pub const MAX_LISTS: usize = 32;
/// Maximum number of accepted domain rules across lists and services.
pub const MAX_RULES: usize = 250_000;
/// Maximum number of retained bounded diagnostics.
pub const MAX_DIAGNOSTICS: usize = 64;
/// Maximum number of services in an operator-provided catalog.
pub const MAX_SERVICES: usize = 64;
/// Maximum number of domain rules on one service.
pub const MAX_DOMAINS_PER_SERVICE: usize = 512;
/// Maximum length of one retained diagnostic detail string.
pub const MAX_DIAGNOSTIC_LEN: usize = 200;
/// Maximum length of one retained evidence rule string.
pub const MAX_RULE_LEN: usize = 200;
/// Maximum length of an id, label, version, source or evidence field.
pub const MAX_FIELD_LEN: usize = 200;
/// Maximum length of a canonical DNS name presentation.
pub const MAX_NAME_LEN: usize = 253;
/// Maximum number of hostnames recognised on one hosts line.
pub const MAX_HOSTS_PER_LINE: usize = 16;

/// Bounds applied while building a candidate. A failed candidate is never
/// swapped into a live worker: `compile` is a pure `Result`-returning build.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Limits {
    pub max_total_bytes: usize,
    pub max_lists: usize,
    pub max_rules: usize,
    pub max_diagnostics: usize,
    pub max_services: usize,
    pub max_domains_per_service: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_total_bytes: MAX_TOTAL_SOURCE_BYTES,
            max_lists: MAX_LISTS,
            max_rules: MAX_RULES,
            max_diagnostics: MAX_DIAGNOSTICS,
            max_services: MAX_SERVICES,
            max_domains_per_service: MAX_DOMAINS_PER_SERVICE,
        }
    }
}
