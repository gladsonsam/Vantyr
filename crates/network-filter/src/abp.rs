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

use adblock::engine::Engine;
use adblock::filters::network::{NetworkFilterMask, NetworkFilterMaskHelper};
use adblock::lists::{parse_filter, FilterSet, ParseOptions, ParsedLine, RuleTypes};
use adblock::request::Request;
use adblock::sourcemap::FilterRuleDebugInfo;

use crate::canonical::canonical_entry;
use crate::hostname_regex::{self, HostnameRegexEngine, RegexRule, RegexVerdictKind};
use crate::limits::Limits;
use crate::types::{bounded_rule, CompileError, Diagnostic, DiagnosticKind, Evidence, SourceKind};

const NO_RULE_EVIDENCE: &str = "upstream adblock result did not expose a raw rule for this match";

pub(crate) struct AbpEngine {
    engine: Engine,
    source_ids: Vec<String>,
    regex: HostnameRegexEngine,
}

pub(crate) enum AbpVerdict {
    ImportantBlock(Evidence),
    Exception(Evidence),
    Block(Evidence),
    NoMatch,
}

impl AbpVerdict {
    fn rank(&self) -> u8 {
        match self {
            Self::ImportantBlock(_) => 3,
            Self::Exception(_) => 2,
            Self::Block(_) => 1,
            Self::NoMatch => 0,
        }
    }
}

/// Which pipeline accepted one validated rule.
enum Accepted {
    Skip,
    Domain,
    Regex(RegexRule),
}

/// `sources` are `(list id, list text)` sorted by id for deterministic
/// `source_index` attribution.
pub(crate) fn build(
    sources: &[(&str, &str)],
    limits: &Limits,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(Option<AbpEngine>, Vec<usize>), CompileError> {
    if sources.is_empty() {
        return Ok((None, Vec::new()));
    }
    let mut set = FilterSet::new(true);
    let mut source_ids: Vec<String> = Vec::new();
    let mut accepted_per_source: Vec<usize> = Vec::new();
    let mut regex_rules: Vec<RegexRule> = Vec::new();

    for (id, text) in sources {
        let mut kept = String::new();
        let mut accepted = 0usize;
        for (index, line) in text.lines().enumerate() {
            match validate(line, id) {
                Ok(Accepted::Domain) => {
                    kept.push_str(line.trim());
                    kept.push('\n');
                    accepted += 1;
                }
                Ok(Accepted::Regex(rule)) => {
                    regex_rules.push(rule);
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
    }

    Ok((
        Some(AbpEngine {
            engine: Engine::new_with_filter_set(set),
            source_ids,
            regex: HostnameRegexEngine::new(regex_rules),
        }),
        accepted_per_source,
    ))
}

/// Classify one line. Regex rules are compiled here; domain rules continue
/// through the upstream parser guard. Comments and blanks are skipped, and
/// every other form gets an explicit bounded diagnostic.
fn validate(line: &str, source_id: &str) -> Result<Accepted, (DiagnosticKind, String)> {
    let rule = line.trim();
    if rule.is_empty() || rule.starts_with('!') || rule.starts_with('[') {
        return Ok(Accepted::Skip);
    }
    if rule.contains("##") || rule.contains("#@#") || rule.contains("$$") || rule.starts_with('#') {
        return Err((
            DiagnosticKind::Unsupported,
            "cosmetic / element-hiding rules are not DNS-representable".to_owned(),
        ));
    }
    if let Some(regex_rule) = hostname_regex::parse(rule, source_id)? {
        return Ok(Accepted::Regex(regex_rule));
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
    let label_count = canonical.trim_end_matches('.').split('.').count();
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
    match parse_filter(rule, true, opts) {
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
            if !upstream_host.eq_ignore_ascii_case(canonical.trim_end_matches('.')) {
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
    }
    Ok(Accepted::Domain)
}

impl AbpEngine {
    pub(crate) fn check(&self, host: &str) -> AbpVerdict {
        let url = format!("http://{host}/");
        let request = Request::preparsed(&url, host, "", "other", false, "");
        let result = self.engine.check_network_request(&request);

        // Precedence is upstream's: `should_block` honours `$important` over
        // exceptions. We only map its result to our typed outcome.
        let upstream = if result.should_block() {
            let evidence = self.evidence(result.filter.as_ref(), result.important);
            if result.important {
                AbpVerdict::ImportantBlock(evidence)
            } else {
                AbpVerdict::Block(evidence)
            }
        } else if result.exception.is_some() {
            AbpVerdict::Exception(self.evidence(result.exception.as_ref(), false))
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

    fn evidence(&self, info: Option<&FilterRuleDebugInfo>, important: bool) -> Evidence {
        let (source_id, rule) = match info {
            Some(info) => {
                let source_id = info
                    .source_location
                    .as_ref()
                    .and_then(|location| self.source_ids.get(location.source_index as usize))
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_owned());
                (source_id, info.raw_line.as_deref().and_then(bounded_rule))
            }
            None => ("unknown".to_owned(), None),
        };
        let note = if rule.is_some() {
            if important {
                "upstream reported an important blocking rule"
            } else {
                "upstream-reported rule"
            }
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
}

fn push(diagnostics: &mut Vec<Diagnostic>, limits: &Limits, diagnostic: Diagnostic) {
    if diagnostics.len() < limits.max_diagnostics {
        diagnostics.push(diagnostic);
    }
}
