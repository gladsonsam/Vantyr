//! Feature-gated thin adapter over the maintained `adblock` 0.13.6 engine.
//!
//! Only DNS-representable domain rules are accepted by the upstream engine. A
//! minimal synthetic `http://<canonical-host>/` carrier is used because that
//! matcher requires a supported request shape; it exists solely to carry the
//! queried hostname. Path, scheme, URL, third-party, content-type and cosmetic
//! rules are rejected with bounded diagnostics rather than silently matched
//! with invented HTTP semantics. Bounded hostname regex rules are compiled and
//! matched separately against the canonical host; see `hostname_regex`.
//! Precedence (`$important` over `@@`) is preserved for both rule families.
//! Important domain exceptions are held in a separate exception-only engine
//! so they are detected deterministically even when an ordinary exception
//! matches the same host.

use adblock::engine::Engine;
use adblock::filters::network::{NetworkFilterMask, NetworkFilterMaskHelper};
use adblock::lists::{parse_filter, FilterSet, ParseOptions, ParsedLine, RuleTypes};
use adblock::request::Request;
use adblock::sourcemap::FilterRuleDebugInfo;

use crate::canonical::canonical_entry;
use crate::dns_rewrite::{self, DnsRewrite, DnsRewritePlan};
use crate::hostname_regex::{
    self, HostnameRegexEngine, RegexBudget, RegexPlan, RegexRule, RegexVerdictKind,
};
use crate::limits::Limits;
use crate::types::{bounded_rule, CompileError, Diagnostic, DiagnosticKind, Evidence, SourceKind};

const NO_RULE_EVIDENCE: &str = "upstream adblock result did not expose a raw rule for this match";
const IMPORTANT_BLOCK_NOTE: &str = "upstream reported an important blocking rule";
const IMPORTANT_EXCEPTION_NOTE: &str = "upstream reported an important exception rule";
const DOMAIN_RULE_NOTE: &str = "upstream-reported rule";

pub(crate) struct AbpEngine {
    engine: Engine,
    source_ids: Vec<String>,
    /// Exception-only engine holding just the validated
    /// `@@||host^$important` domain rules. Upstream reports only one selected
    /// exception for a match, so reading importance from that result is
    /// nondeterministic when ordinary and important exceptions overlap. A
    /// separate engine makes the important case unambiguous.
    important_exceptions: Option<Engine>,
    important_source_ids: Vec<String>,
    regex: HostnameRegexEngine,
}

pub(crate) enum AbpVerdict {
    /// An `@@||host^$important` exception, identified by the dedicated
    /// exception-only engine. It outranks every block so the domain-rule
    /// important-exception semantics survive a regex important block.
    ImportantException(Evidence),
    ImportantBlock(Evidence),
    Exception(Evidence),
    Block(Evidence),
    NoMatch,
}

impl AbpVerdict {
    fn rank(&self) -> u8 {
        match self {
            Self::ImportantException(_) => 4,
            Self::ImportantBlock(_) => 3,
            Self::Exception(_) => 2,
            Self::Block(_) => 1,
            Self::NoMatch => 0,
        }
    }
}

/// Result of compiling one ABP source group. Rewrite rules are separate from
/// the block/exception engines: they must never become blocks.
pub(crate) struct AbpBuild {
    pub(crate) engine: Option<AbpEngine>,
    pub(crate) accepted_per_source: Vec<usize>,
    pub(crate) rewrites: Vec<DnsRewrite>,
    pub(crate) exception_owners: Vec<String>,
}

/// Which pipeline accepted one validated rule.
enum Accepted {
    Skip,
    Domain {
        /// Upstream metadata says this is an `@@...$important` rule, so it is
        /// routed to the dedicated exception-only engine.
        important_exception: bool,
        /// Whether the pattern carried the `@@` exception prefix. Accepted
        /// domain exceptions are indexed so they can suppress list rewrites
        /// even when upstream has no block to pair them with.
        exception: bool,
        /// Canonical ASCII owner without its trailing dot.
        owner: String,
    },
    /// Classified but not compiled: the global budget is charged first.
    Regex(RegexPlan),
    /// A typed `$dnsrewrite` rule, compiled without entering the block engine.
    DnsRewrite(DnsRewritePlan),
}

/// `sources` are `(list id, list text)` sorted by id for deterministic
/// `source_index` attribution.
pub(crate) fn build(
    sources: &[(&str, &str)],
    limits: &Limits,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<AbpBuild, CompileError> {
    if sources.is_empty() {
        return Ok(AbpBuild {
            engine: None,
            accepted_per_source: Vec::new(),
            rewrites: Vec::new(),
            exception_owners: Vec::new(),
        });
    }
    let mut set = FilterSet::new(true);
    let mut source_ids: Vec<String> = Vec::new();
    let mut important_set = FilterSet::new(true);
    let mut important_source_ids: Vec<String> = Vec::new();
    let mut accepted_per_source: Vec<usize> = Vec::new();
    let mut regex_rules: Vec<RegexRule> = Vec::new();
    let mut regex_budget = RegexBudget::new();
    let mut rewrites: Vec<DnsRewrite> = Vec::new();
    let mut exception_owners: Vec<String> = Vec::new();

    for (id, text) in sources {
        let mut kept = String::new();
        let mut important_kept = String::new();
        let mut accepted = 0usize;
        for (index, line) in text.lines().enumerate() {
            match validate(line) {
                Ok(Accepted::Domain {
                    important_exception,
                    exception,
                    owner,
                }) => {
                    // Partition important exceptions into the dedicated
                    // engine. The main engine then only ever selects ordinary
                    // exceptions, so no verdict depends on which one upstream
                    // happens to return.
                    if important_exception {
                        important_kept.push_str(line.trim());
                        important_kept.push('\n');
                    } else {
                        kept.push_str(line.trim());
                        kept.push('\n');
                    }
                    if exception {
                        exception_owners.push(owner);
                    }
                    accepted += 1;
                }
                Ok(Accepted::Regex(plan)) => {
                    // Charge the global budget before compiling anything: an
                    // overflow rejects the whole candidate with a bounded
                    // diagnostic, no matter how many sources it is split over.
                    if let Err((kind, detail)) = regex_budget.charge(&plan, limits) {
                        push_fatal(
                            diagnostics,
                            limits,
                            Diagnostic::new(id, index + 1, kind, detail),
                        );
                        return Err(CompileError::Rejected(diagnostics.clone()));
                    }
                    match plan.compile(id) {
                        Ok(rule) => {
                            regex_rules.push(rule);
                            accepted += 1;
                        }
                        Err((kind, detail)) => push(
                            diagnostics,
                            limits,
                            Diagnostic::new(id, index + 1, kind, detail),
                        ),
                    }
                }
                Ok(Accepted::DnsRewrite(plan)) => {
                    // Charge the explicit global cap across every source,
                    // before publishing any index. An overflow is fatal and
                    // cannot be diluted by splitting rules over more lists.
                    if rewrites.len() >= limits.max_dns_rewrites {
                        push_fatal(
                            diagnostics,
                            limits,
                            Diagnostic::new(
                                id,
                                index + 1,
                                DiagnosticKind::Limit("dns rewrite count".to_owned()),
                                "global typed dnsrewrite rule cap exceeded",
                            ),
                        );
                        return Err(CompileError::Rejected(diagnostics.clone()));
                    }
                    rewrites.push(plan.into_rewrite(id, index + 1));
                    accepted += 1;
                }
                Ok(Accepted::Skip) => {}
                Err((kind, detail)) => push(
                    diagnostics,
                    limits,
                    Diagnostic::new(id, index + 1, kind, detail),
                ),
            }
        }
        if accepted == 0 {
            push(
                diagnostics,
                limits,
                Diagnostic::new(
                    id,
                    0,
                    DiagnosticKind::EmptySource,
                    "no DNS-representable ABP domain rule in source",
                ),
            );
            return Err(CompileError::Rejected(diagnostics.clone()));
        }
        accepted_per_source.push(accepted);
        if accepted_per_source.iter().sum::<usize>() > limits.max_rules {
            return Err(CompileError::Limit(format!(
                "ABP rule count exceeds bound {}",
                limits.max_rules
            )));
        }
        let record = set.add_filter_list(
            kept,
            ParseOptions {
                rule_types: RuleTypes::NetworkOnly,
                ..ParseOptions::default()
            },
        );
        while source_ids.len() <= record.source_index {
            source_ids.push("unknown".to_owned());
        }
        source_ids[record.source_index] = (*id).to_owned();

        if !important_kept.is_empty() {
            let record = important_set.add_filter_list(
                important_kept,
                ParseOptions {
                    rule_types: RuleTypes::NetworkOnly,
                    ..ParseOptions::default()
                },
            );
            while important_source_ids.len() <= record.source_index {
                important_source_ids.push("unknown".to_owned());
            }
            important_source_ids[record.source_index] = (*id).to_owned();
        }
    }

    Ok(AbpBuild {
        engine: Some(AbpEngine {
            engine: Engine::new_with_filter_set(set),
            source_ids,
            important_exceptions: if important_source_ids.is_empty() {
                None
            } else {
                Some(Engine::new_with_filter_set(important_set))
            },
            important_source_ids,
            regex: HostnameRegexEngine::new(regex_rules),
        }),
        accepted_per_source,
        rewrites,
        exception_owners,
    })
}

/// Classify one line. Regex rules are recognised before the cosmetic guard:
/// a regex body may legitimately contain `##`, `#@#` or `$$`, which are only
/// cosmetic markers at the rule boundary (outside a delimited regex). Domain
/// rules continue through the upstream parser guard. Comments and blanks are
/// skipped, and every other form gets an explicit bounded diagnostic.
fn validate(line: &str) -> Result<Accepted, (DiagnosticKind, String)> {
    let rule = line.trim();
    if rule.is_empty() || rule.starts_with('!') || rule.starts_with('[') {
        return Ok(Accepted::Skip);
    }
    if let Some(plan) = hostname_regex::classify(rule)? {
        return Ok(Accepted::Regex(plan));
    }
    if rule.contains("##") || rule.contains("#@#") || rule.contains("$$") || rule.starts_with('#') {
        return Err((
            DiagnosticKind::Unsupported,
            "cosmetic / element-hiding rules are not DNS-representable".to_owned(),
        ));
    }
    if rule.contains("://") {
        return Err((
            DiagnosticKind::Unsupported,
            "scheme-specific request rules are not DNS-representable".to_owned(),
        ));
    }
    if rule.contains('/') {
        return Err((
            DiagnosticKind::Unsupported,
            "path patterns are not supported".to_owned(),
        ));
    }

    let (pattern, options) = match rule.split_once('$') {
        Some((pattern, options)) => (pattern, Some(options)),
        None => (rule, None),
    };
    if let Some(options) = options {
        // Route the typed rewrite slice before the generic modifier guard:
        // adblock 0.13.6 exposes no typed dnsrewrite, so these rules are
        // compiled by the bounded parser here and never enter the block engine.
        if options
            .split(',')
            .any(|option| option.eq_ignore_ascii_case("dnsrewrite")
                || option
                    .split_once('=')
                    .map(|(key, _)| key.eq_ignore_ascii_case("dnsrewrite"))
                    .unwrap_or(false))
        {
            return validate_rewrite(rule, pattern, options);
        }
        for option in options.split(',') {
            if option != "important" {
                return Err((
                    DiagnosticKind::Unsupported,
                    format!("${option} needs request context this adapter does not provide"),
                ));
            }
        }
    }
    if pattern.split_whitespace().count() != 1 {
        return Err((
            DiagnosticKind::Unsupported,
            "whitespace-separated request patterns are not supported".to_owned(),
        ));
    }

    let (exception, anchored) = match pattern.strip_prefix("@@") {
        Some(rest) => (true, rest),
        None => (false, pattern),
    };
    let domain = anchored.strip_prefix("||").ok_or_else(|| {
        (
            DiagnosticKind::Unsupported,
            "only domain-anchored ||host^ rules are supported; bare patterns are ambiguous"
                .to_owned(),
        )
    })?;
    let domain = domain.strip_suffix('^').ok_or_else(|| {
        (
            DiagnosticKind::Unsupported,
            "rules must end in ^ for an explicit label boundary".to_owned(),
        )
    })?;
    if domain.contains('*') {
        return Err((
            DiagnosticKind::Unsupported,
            "wildcards belong in hosts sources, not ABP domain rules".to_owned(),
        ));
    }
    let canonical =
        canonical_entry(domain).map_err(|reason| (DiagnosticKind::Malformed, reason))?;
    let owner = canonical.trim_end_matches('.').to_ascii_lowercase();
    let label_count = owner.split('.').count();
    if label_count < 2 {
        return Err((
            DiagnosticKind::Unsupported,
            "single-label domains are too broad to accept".to_owned(),
        ));
    }

    // Confirm with the upstream parser and its public mask/metadata rather
    // than trusting our lexical guard alone.
    let opts = ParseOptions {
        rule_types: RuleTypes::NetworkOnly,
        ..ParseOptions::default()
    };
    let important_exception = match parse_filter(rule, true, opts) {
        Ok(ParsedLine::Network(filter)) => {
            if filter.mask.is_regex()
                || filter.mask.is_complete_regex()
                || filter.mask.contains(NetworkFilterMask::IS_HOSTNAME_REGEX)
                || filter.mask.match_case()
            {
                return Err((
                    DiagnosticKind::Unsupported,
                    "regex-shaped and case-sensitive domain rules are not accepted here".to_owned(),
                ));
            }
            if filter.is_badfilter()
                || filter.is_csp()
                || filter.is_redirect()
                || filter.is_removeparam()
                || filter.is_generic_hide()
                || filter.has_to_option()
                || filter.modifier_option.is_some()
                || filter.opt_domains.is_some()
                || filter.opt_not_domains.is_some()
                || filter.opt_to_domains.is_some()
            {
                return Err((
                    DiagnosticKind::Unsupported,
                    "modifier-bearing rules are not DNS-representable".to_owned(),
                ));
            }
            if !filter.mask.is_hostname_anchor() {
                return Err((
                    DiagnosticKind::Unsupported,
                    "upstream parsed rule without a hostname anchor".to_owned(),
                ));
            }
            let upstream_host = filter.hostname.as_deref().unwrap_or("");
            if !upstream_host.eq_ignore_ascii_case(&owner) {
                return Err((
                    DiagnosticKind::Malformed,
                    "upstream hostname does not match the canonical domain".to_owned(),
                ));
            }
            if filter.mask.is_exception() != exception {
                return Err((
                    DiagnosticKind::Malformed,
                    "upstream exception flag disagrees with the rule prefix".to_owned(),
                ));
            }
            // Captured from upstream's own mask here while `filter` is in
            // scope, not later inferred from a selected raw line.
            exception && filter.mask.is_important()
        }
        Ok(ParsedLine::Cosmetic(_)) => {
            return Err((
                DiagnosticKind::Unsupported,
                "cosmetic rules are not DNS-representable".to_owned(),
            ));
        }
        Err(error) => {
            return Err((
                DiagnosticKind::Malformed,
                format!("upstream parser rejected rule: {error}"),
            ));
        }
    };
    Ok(Accepted::Domain {
        important_exception,
        exception,
        owner,
    })
}

/// Validate the first typed `$dnsrewrite` slice. This ruleset is intentionally
/// narrow: the maintained adblock engine exposes no typed DNS rewrite, so the
/// bounded parser here is the authority and combined/context modifiers,
/// rewrite exceptions, wildcards, response codes and other RR types are
/// reported honestly instead of being given invented meanings.
fn validate_rewrite(
    rule: &str,
    pattern: &str,
    options: &str,
) -> Result<Accepted, (DiagnosticKind, String)> {
    if options.split(',').count() != 1 {
        return Err((
            DiagnosticKind::Unsupported,
            "modifiers combined with dnsrewrite are not supported".to_owned(),
        ));
    }
    let value = match options.split_once('=') {
        Some((key, value)) if key.eq_ignore_ascii_case("dnsrewrite") => value,
        _ => {
            return Err((
                DiagnosticKind::Unsupported,
                "rewrite exceptions (@@...$dnsrewrite) are not supported".to_owned(),
            ));
        }
    };
    if pattern.starts_with("@@") {
        return Err((
            DiagnosticKind::Unsupported,
            "rewrite exceptions are not supported in this slice".to_owned(),
        ));
    }
    if pattern.split_whitespace().count() != 1 {
        return Err((
            DiagnosticKind::Unsupported,
            "whitespace-separated rewrite patterns are not supported".to_owned(),
        ));
    }
    let domain = pattern.strip_prefix("||").ok_or_else(|| {
        (
            DiagnosticKind::Unsupported,
            "dnsrewrite rules must be domain-anchored with ||host^".to_owned(),
        )
    })?;
    let domain = domain.strip_suffix('^').ok_or_else(|| {
        (
            DiagnosticKind::Unsupported,
            "dnsrewrite rules must end in ^ for an explicit label boundary".to_owned(),
        )
    })?;
    if domain.contains('*') {
        return Err((
            DiagnosticKind::Unsupported,
            "wildcards are not supported in dnsrewrite rules".to_owned(),
        ));
    }
    let canonical =
        canonical_entry(domain).map_err(|reason| (DiagnosticKind::Malformed, reason))?;
    let owner = canonical.trim_end_matches('.').to_ascii_lowercase();
    if owner.split('.').count() < 2 {
        return Err((
            DiagnosticKind::Unsupported,
            "single-label dnsrewrite owners are too broad to accept".to_owned(),
        ));
    }
    let value = dns_rewrite::parse_value(value)?;
    Ok(Accepted::DnsRewrite(DnsRewritePlan {
        owner,
        value,
        raw: bounded_rule(rule).unwrap_or_default(),
    }))
}

impl AbpEngine {
    pub(crate) fn check(&self, host: &str) -> AbpVerdict {
        let url = format!("http://{host}/");
        let request = Request::preparsed(&url, host, "", "other", false, "");

        // Important domain exceptions live in a dedicated exception-only
        // engine. Upstream reports a single selected exception for a match,
        // which is nondeterministic when an ordinary and an important
        // exception both match. Checking the dedicated engine first makes the
        // important verdict independent of that selection, and the evidence
        // still names the rule and source that actually matched.
        if let Some(engine) = &self.important_exceptions {
            // The exception-only engine has no blocking filters, so upstream
            // would otherwise skip exception lookup entirely. Force it so the
            // dedicated engine reports its matched important exception.
            let dedicated = engine.check_network_request_subset(&request, false, true);
            if let Some(info) = dedicated.exception.as_ref() {
                return AbpVerdict::ImportantException(self.important_evidence(Some(info)));
            }
        }

        let result = self.engine.check_network_request(&request);

        // The main engine holds no important exceptions: they were partitioned
        // into the dedicated engine above. Its `important` flag therefore only
        // describes a matched blocking filter, and any exception it selects is
        // an ordinary one.
        let upstream = if result.important {
            AbpVerdict::ImportantBlock(self.evidence(result.filter.as_ref(), IMPORTANT_BLOCK_NOTE))
        } else if let Some(info) = result.exception.as_ref() {
            AbpVerdict::Exception(self.evidence(Some(info), DOMAIN_RULE_NOTE))
        } else if result.should_block() {
            AbpVerdict::Block(self.evidence(result.filter.as_ref(), DOMAIN_RULE_NOTE))
        } else {
            AbpVerdict::NoMatch
        };

        // Hostname regex rules use the same typed verdicts and the same
        // important > exception > block order. On an equal rank the upstream
        // domain-rule result stays authoritative, preserving prior behavior.
        let upstream_rank = upstream.rank();
        if let Some(verdict) = self.regex.check(host) {
            let candidate = match verdict.kind {
                RegexVerdictKind::ImportantBlock => AbpVerdict::ImportantBlock(verdict.evidence),
                RegexVerdictKind::Exception => AbpVerdict::Exception(verdict.evidence),
                RegexVerdictKind::Block => AbpVerdict::Block(verdict.evidence),
            };
            if candidate.rank() > upstream_rank {
                return candidate;
            }
        }
        upstream
    }

    fn evidence(&self, info: Option<&FilterRuleDebugInfo>, note: &'static str) -> Evidence {
        build_evidence(info, &self.source_ids, note)
    }

    /// Evidence for a match in the dedicated engine must use that engine's
    /// source mapping; its `source_index` values are not the main engine's.
    fn important_evidence(&self, info: Option<&FilterRuleDebugInfo>) -> Evidence {
        build_evidence(info, &self.important_source_ids, IMPORTANT_EXCEPTION_NOTE)
    }
}

/// Build truthful evidence from upstream debug info and the source mapping of
/// the engine that produced the match.
fn build_evidence(
    info: Option<&FilterRuleDebugInfo>,
    source_ids: &[String],
    note: &'static str,
) -> Evidence {
    let (source_id, rule) = match info {
        Some(info) => {
            let source_id = info
                .source_location
                .as_ref()
                .and_then(|location| source_ids.get(location.source_index as usize))
                .cloned()
                .unwrap_or_else(|| "unknown".to_owned());
            (source_id, info.raw_line.as_deref().and_then(bounded_rule))
        }
        None => ("unknown".to_owned(), None),
    };
    let note = if rule.is_some() {
        note
    } else {
        NO_RULE_EVIDENCE
    };
    Evidence {
        source_id,
        source_kind: SourceKind::List,
        rule,
        note,
    }
}

fn push(diagnostics: &mut Vec<Diagnostic>, limits: &Limits, diagnostic: Diagnostic) {
    if diagnostics.len() < limits.max_diagnostics {
        diagnostics.push(diagnostic);
    }
}

/// A budget overflow must be reported even when earlier diagnostics already
/// filled the bounded list: drop the oldest one to make room.
fn push_fatal(diagnostics: &mut Vec<Diagnostic>, limits: &Limits, diagnostic: Diagnostic) {
    if limits.max_diagnostics > 0 && diagnostics.len() >= limits.max_diagnostics {
        diagnostics.pop();
    }
    push(diagnostics, limits, diagnostic);
}
