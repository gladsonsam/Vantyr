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
/// Global cap on accepted typed DNS rewrite rules across all ABP sources.
/// Every rewrite is indexed by owner and selected on each supported query, so
/// this bounds the compiled index independently of the looser `max_rules`.
pub const MAX_DNS_REWRITES: usize = 512;

/// Maximum text length of one hostname regex pattern.
pub const MAX_REGEX_PATTERN_LEN: usize = MAX_RULE_LEN;
/// Maximum compiled-program size charged (and enforced) per regex pattern.
pub const MAX_REGEX_PROGRAM_BYTES: usize = 256 * 1024;
/// Maximum DFA-cache size charged (and enforced) per regex pattern.
pub const MAX_REGEX_DFA_BYTES: usize = 256 * 1024;
/// Maximum nesting depth per regex pattern.
pub const MAX_REGEX_NEST: u32 = 32;
/// Deterministic charge made to the aggregate reservation for each accepted
/// regex rule: its full program allowance plus its full DFA allowance.
pub const REGEX_RESERVATION_PER_RULE: usize = MAX_REGEX_PROGRAM_BYTES + MAX_REGEX_DFA_BYTES;

/// Maximum number of hostname regex rules accepted across ALL ABP sources.
/// Every regex rule is tested on each supported query, so this bounds the
/// linear per-query scan independently of `max_rules`.
pub const MAX_REGEX_RULES: usize = 512;
/// Maximum aggregate regex pattern-text bytes across ALL ABP sources. A proxy
/// for per-query scan work: longer patterns cost more to match and are charged
/// by their text length.
pub const MAX_REGEX_WORK_BYTES: usize = 64 * 1024;
/// Maximum aggregate compilation reservation across ALL ABP sources. Each
/// accepted rule charges `REGEX_RESERVATION_PER_RULE`, so this is a bounded
/// accounting value, not a claim about process RSS (the automata engines keep
/// their own lazily allocated, partly thread-local caches).
pub const MAX_REGEX_RESERVATION_BYTES: usize = 256 * 1024 * 1024;

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
    /// Global cap on accepted hostname regex rules across all sources.
    pub max_regex_rules: usize,
    /// Global cap on aggregate regex pattern-text bytes across all sources.
    pub max_regex_work_bytes: usize,
    /// Global cap on the aggregate regex compilation reservation.
    pub max_regex_reservation_bytes: usize,
    /// Global cap on accepted typed DNS rewrite rules across all sources.
    pub max_dns_rewrites: usize,
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
            max_regex_rules: MAX_REGEX_RULES,
            max_regex_work_bytes: MAX_REGEX_WORK_BYTES,
            max_regex_reservation_bytes: MAX_REGEX_RESERVATION_BYTES,
            max_dns_rewrites: MAX_DNS_REWRITES,
        }
    }
}
