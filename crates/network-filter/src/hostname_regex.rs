//! Bounded hostname regex rules from ABP-style DNS filter lists.
//!
//! A rule of the form `/regexp/` (or `@@/regexp/`) is matched against the
//! canonical DNS hostname presentation only: ASCII, lowercase, punycode for
//! internationalised names and without a trailing dot. No URL, path, scheme or
//! synthetic request carrier is involved, so a pattern written for a URL can
//! never silently acquire hostname semantics here.
//!
//! The maintained `regex` crate compiles patterns into finite automata (no
//! backtracking). Every compilation is given explicit program-size, DFA-size
//! and nesting bounds so an untrusted list cannot consume unbounded memory.
//! Rules are kept in source-id/line order, which makes evidence deterministic.

use regex::{Error as RegexError, Regex, RegexBuilder};

use crate::limits::{
    Limits, MAX_REGEX_DFA_BYTES, MAX_REGEX_NEST, MAX_REGEX_PATTERN_LEN, MAX_REGEX_PROGRAM_BYTES,
    REGEX_RESERVATION_PER_RULE,
};
use crate::types::{bounded_rule, DiagnosticKind, Evidence, SourceKind};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RegexVerdictKind {
    ImportantBlock,
    Exception,
    Block,
}

impl RegexVerdictKind {
    fn rank(self) -> u8 {
        match self {
            Self::ImportantBlock => 3,
            Self::Exception => 2,
            Self::Block => 1,
        }
    }

    fn note(self) -> &'static str {
        match self {
            Self::ImportantBlock => "important hostname regex rule",
            Self::Exception => "hostname regex exception rule",
            Self::Block => "hostname regex rule",
        }
    }
}

/// A classified but not yet compiled regex rule. `abp::build` charges the
/// global budget against this plan *before* spending compilation work, then
/// calls `compile`.
#[derive(Debug)]
pub(crate) struct RegexPlan {
    pattern: String,
    kind: RegexVerdictKind,
    raw: String,
}

impl RegexPlan {
    /// Compile with the per-pattern bounds. Kept separate from classification
    /// so the aggregate budget can reject the whole candidate first.
    pub(crate) fn compile(self, source_id: &str) -> Result<RegexRule, (DiagnosticKind, String)> {
        let regex = RegexBuilder::new(&self.pattern)
            // The matched host is already lowercase ASCII; folding keeps regex
            // rules as insensitive to query case as the domain rules are.
            .case_insensitive(true)
            .size_limit(MAX_REGEX_PROGRAM_BYTES)
            .dfa_size_limit(MAX_REGEX_DFA_BYTES)
            .nest_limit(MAX_REGEX_NEST)
            .build()
            .map_err(|error| {
                if matches!(error, RegexError::CompiledTooBig(_)) {
                    (
                        DiagnosticKind::Limit("regex compiled size".to_owned()),
                        "regex pattern exceeds the bounded compilation size".to_owned(),
                    )
                } else {
                    (
                        DiagnosticKind::Malformed,
                        format!("regex compile error: {error}"),
                    )
                }
            })?;
        Ok(RegexRule {
            regex,
            kind: self.kind,
            source_id: source_id.to_owned(),
            raw: self.raw,
        })
    }
}

/// Global, cumulative accounting for regex rules across ALL sources. It is
/// charged before any pattern is compiled so an adversarial multi-source
/// candidate cannot spend unbounded compilation work before being rejected.
#[derive(Default)]
pub(crate) struct RegexBudget {
    rules: usize,
    work_bytes: usize,
    reservation_bytes: usize,
}

impl RegexBudget {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn charge(
        &mut self,
        plan: &RegexPlan,
        limits: &Limits,
    ) -> Result<(), (DiagnosticKind, String)> {
        self.rules = self.rules.saturating_add(1);
        self.work_bytes = self.work_bytes.saturating_add(plan.pattern.len());
        self.reservation_bytes = self
            .reservation_bytes
            .saturating_add(REGEX_RESERVATION_PER_RULE);

        if self.rules > limits.max_regex_rules {
            return Err((
                DiagnosticKind::Limit("regex rule count".to_owned()),
                format!(
                    "regex rule count exceeds global bound {}",
                    limits.max_regex_rules
                ),
            ));
        }
        if self.work_bytes > limits.max_regex_work_bytes {
            return Err((
                DiagnosticKind::Limit("regex work".to_owned()),
                format!(
                    "aggregate regex pattern bytes exceed global bound {}",
                    limits.max_regex_work_bytes
                ),
            ));
        }
        if self.reservation_bytes > limits.max_regex_reservation_bytes {
            return Err((
                DiagnosticKind::Limit("regex reservation".to_owned()),
                format!(
                    "aggregate regex compilation reservation exceeds global bound {}",
                    limits.max_regex_reservation_bytes
                ),
            ));
        }
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) struct RegexRule {
    regex: Regex,
    kind: RegexVerdictKind,
    source_id: String,
    raw: String,
}

pub(crate) struct RegexVerdict {
    pub(crate) kind: RegexVerdictKind,
    pub(crate) evidence: Evidence,
}

/// Classify one trimmed rule without compiling it. `Ok(None)` means the rule
/// is not a regex rule and must continue through the ordinary domain-rule path.
pub(crate) fn classify(rule: &str) -> Result<Option<RegexPlan>, (DiagnosticKind, String)> {
    let (exception, remainder) = match rule.strip_prefix("@@") {
        Some(rest) => (true, rest),
        None => (false, rule),
    };
    let (pattern, tail) = match remainder.strip_prefix('/') {
        Some(_) => split_pattern(remainder).ok_or_else(|| {
            (
                DiagnosticKind::Malformed,
                "regex rule has no closing delimiter".to_owned(),
            )
        })?,
        None => return Ok(None),
    };
    if pattern.is_empty() {
        return Err((
            DiagnosticKind::Malformed,
            "regex pattern is empty".to_owned(),
        ));
    }
    if pattern.len() > MAX_REGEX_PATTERN_LEN {
        return Err((
            DiagnosticKind::Limit("regex pattern length".to_owned()),
            "regex pattern exceeds the bounded length".to_owned(),
        ));
    }

    let important = parse_modifiers(tail, exception)?;
    let kind = if important {
        RegexVerdictKind::ImportantBlock
    } else if exception {
        RegexVerdictKind::Exception
    } else {
        RegexVerdictKind::Block
    };
    Ok(Some(RegexPlan {
        pattern: pattern.to_owned(),
        kind,
        raw: rule.to_owned(),
    }))
}

/// Split `/body/tail`, honouring backslash-escaped slashes inside the body.
fn split_pattern(rule: &str) -> Option<(&str, &str)> {
    let mut escaped = false;
    for (index, character) in rule.char_indices().skip(1) {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '/' => return Some((&rule[1..index], &rule[index + 1..])),
            _ => {}
        }
    }
    None
}

/// Only the already-supported `important` modifier is accepted, and only on a
/// blocking regex. An important exception would need to override important
/// blocks from other rules, which is not modelled here; it is diagnosed
/// instead of being silently weakened into an ordinary exception.
fn parse_modifiers(tail: &str, exception: bool) -> Result<bool, (DiagnosticKind, String)> {
    if tail.is_empty() {
        return Ok(false);
    }
    let options = tail.strip_prefix('$').ok_or_else(|| {
        (
            DiagnosticKind::Malformed,
            "regex delimiter must be followed by modifiers or end of rule".to_owned(),
        )
    })?;
    let mut important = false;
    for option in options.split(',') {
        if option != "important" {
            return Err((
                DiagnosticKind::Unsupported,
                format!("${option} needs request context this adapter does not provide"),
            ));
        }
        important = true;
    }
    if exception && important {
        return Err((
            DiagnosticKind::Unsupported,
            "important exceptions are not supported for hostname regex rules".to_owned(),
        ));
    }
    Ok(important)
}

/// Immutable set of compiled regex rules. Rules are appended in sorted source
/// id and ascending line order by `abp::build`, so both match selection and
/// evidence are deterministic.
pub(crate) struct HostnameRegexEngine {
    rules: Vec<RegexRule>,
}

impl HostnameRegexEngine {
    pub(crate) fn new(rules: Vec<RegexRule>) -> Self {
        Self { rules }
    }

    pub(crate) fn check(&self, host: &str) -> Option<RegexVerdict> {
        let mut best: Option<(&RegexRule, u8)> = None;
        for rule in &self.rules {
            if !rule.regex.is_match(host) {
                continue;
            }
            let rank = rule.kind.rank();
            if best.is_none_or(|(_, current)| rank > current) {
                best = Some((rule, rank));
            }
        }
        best.map(|(rule, _)| RegexVerdict {
            kind: rule.kind,
            evidence: Evidence {
                source_id: rule.source_id.clone(),
                source_kind: SourceKind::List,
                rule: bounded_rule(&rule.raw),
                note: rule.kind.note(),
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escaped_slashes_and_closing_delimiter_are_parsed() {
        let rule = classify(r"/^a\/b$/")
            .unwrap()
            .unwrap()
            .compile("id")
            .unwrap();
        assert_eq!(rule.kind, RegexVerdictKind::Block);
        assert!(rule.regex.is_match("a/b"));
        assert!(!rule.regex.is_match("a"));

        assert!(classify(r"/unterminated").is_err());
        assert!(classify(r"//").is_err());
        assert!(classify(r"||plain.example^").unwrap().is_none());
    }

    #[test]
    fn important_exception_regex_is_diagnosed() {
        let error = classify(r"@@/foo/$important").unwrap_err();
        assert_eq!(error.0, DiagnosticKind::Unsupported);
        assert!(error.1.contains("important exceptions"));
    }

    #[test]
    fn nesting_bound_is_enforced() {
        let mut pattern = String::from("/");
        pattern.push_str(&"(".repeat(usize::try_from(MAX_REGEX_NEST).unwrap() + 8));
        pattern.push('a');
        pattern.push_str(&")".repeat(usize::try_from(MAX_REGEX_NEST).unwrap() + 8));
        pattern.push('/');
        let error = classify(&pattern)
            .unwrap()
            .unwrap()
            .compile("id")
            .unwrap_err();
        assert_eq!(error.0, DiagnosticKind::Malformed);
        assert!(error.1.contains("regex compile error"));
    }

    #[test]
    fn global_budget_counts_across_plans_before_compilation() {
        let limits = Limits {
            max_regex_rules: 2,
            max_regex_work_bytes: 8,
            max_regex_reservation_bytes: 2 * REGEX_RESERVATION_PER_RULE,
            ..Limits::default()
        };
        let mut budget = RegexBudget::new();
        let first = classify(r"/^a$/").unwrap().unwrap();
        let second = classify(r"/^bb$/").unwrap().unwrap();
        let third = classify(r"/^ccc$/").unwrap().unwrap();
        budget.charge(&first, &limits).unwrap();
        budget.charge(&second, &limits).unwrap();
        let error = budget.charge(&third, &limits).unwrap_err();
        assert_eq!(
            error.0,
            DiagnosticKind::Limit("regex rule count".to_owned())
        );
    }
}
