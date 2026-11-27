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

use crate::limits::MAX_RULE_LEN;
use crate::types::{bounded_rule, DiagnosticKind, Evidence, SourceKind};

/// One pattern's text is bounded by the same length used to bound evidence.
const MAX_REGEX_PATTERN_LEN: usize = MAX_RULE_LEN;
const MAX_REGEX_PROGRAM_BYTES: usize = 256 * 1024;
const MAX_REGEX_DFA_BYTES: usize = 256 * 1024;
const MAX_REGEX_NEST: u32 = 32;

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

/// Parse one trimmed rule. `Ok(None)` means the rule is not a regex rule and
/// must continue through the ordinary domain-rule path.
pub(crate) fn parse(
    rule: &str,
    source_id: &str,
) -> Result<Option<RegexRule>, (DiagnosticKind, String)> {
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
    let regex = RegexBuilder::new(pattern)
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

    let kind = if important {
        RegexVerdictKind::ImportantBlock
    } else if exception {
        RegexVerdictKind::Exception
    } else {
        RegexVerdictKind::Block
    };
    Ok(Some(RegexRule {
        regex,
        kind,
        source_id: source_id.to_owned(),
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
        let rule = parse(r"/^a\/b$/", "id").unwrap().unwrap();
        assert_eq!(rule.kind, RegexVerdictKind::Block);
        assert!(rule.regex.is_match("a/b"));
        assert!(!rule.regex.is_match("a"));

        assert!(parse(r"/unterminated", "id").is_err());
        assert!(parse(r"//", "id").is_err());
        assert!(parse(r"||plain.example^", "id").unwrap().is_none());
    }

    #[test]
    fn important_exception_regex_is_diagnosed() {
        let error = parse(r"@@/foo/$important", "id").unwrap_err();
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
        let error = parse(&pattern, "id").unwrap_err();
        assert_eq!(error.0, DiagnosticKind::Malformed);
        assert!(error.1.contains("regex compile error"));
    }
}
