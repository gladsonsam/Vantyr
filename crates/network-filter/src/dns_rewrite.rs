//! Bounded, compiler-only typed DNS rewrite slice for ABP list sources.
//!
//! This module parses the first documented `$dnsrewrite` slice: typed `NOERROR`
//! `A`, `AAAA` and `CNAME` values plus the shorthand IPv4, IPv6 and hostname
//! forms. It produces immutable typed values and an owner index; it does NOT
//! build DNS messages, enforce anything at runtime, or claim a capability.
//! A future thin worker integration owns response construction and ordering
//! against the household policy.
//!
//! All host values are canonicalised through the existing Hickory `Name`
//! parser (ASCII/punycode, lowercase, no trailing dot, no wildcards). Owners
//! follow the documented `||host^` semantics: the owner and every subdomain at
//! a label boundary, never a lookalike such as `notexample.com`.
//!
//! The grammar uses domain anchors, the `RCODE;RRTYPE;VALUE` form and
//! shorthands. Zero delimiters select a shorthand; two select the full form.
//! Keyword, IP and hostname classification is explicit and bounded.

use std::collections::{BTreeMap, BTreeSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use hickory_server::proto::rr::RecordType;

use crate::canonical;
use crate::limits::{Limits, MAX_RULE_LEN};
use crate::types::{bounded_rule, CompileError, Diagnostic, DiagnosticKind, Evidence, SourceKind};

/// Truthful note attached to every accepted typed rewrite's evidence.
pub(crate) const DNS_REWRITE_NOTE: &str = "typed dnsrewrite rule from an ABP list source";

/// The typed value of an accepted first-slice DNS rewrite. The response code
/// is implicitly `NOERROR`; suppression codes and other RR types are diagnosed
/// as unsupported rather than being given an invented meaning here.
#[derive(Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum DnsRewriteValue {
    /// `NOERROR;A;<ipv4>` or the IPv4 shorthand.
    A(Ipv4Addr),
    /// `NOERROR;AAAA;<ipv6>` or the IPv6 shorthand.
    Aaaa(Ipv6Addr),
    /// `NOERROR;CNAME;<host>` or the hostname shorthand. The target is the
    /// canonical ASCII/punycode presentation without a trailing dot.
    Cname(String),
}

/// One accepted typed rewrite, with bounded provenance for the source line it
/// was derived from. `owner` is a canonical ASCII name without a trailing dot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DnsRewrite {
    pub owner: String,
    pub value: DnsRewriteValue,
    pub evidence: Evidence,
    /// 1-based line in the raw source, retained for deterministic selection.
    pub line: usize,
}

/// The distinct typed records of one matched canonical owner. This is the
/// immutable selection object: the owner is the most specific list owner that
/// matched the query name, and `records` holds every distinct typed value for
/// that owner (each with its own bounded provenance) in deterministic
/// `(source id, line)` order. Query-type shaping happens in `records_for`, not
/// in the owner selection, so no record is silently dropped by an unused
/// query-type parameter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DnsRewriteSelection {
    /// Canonical owner without a trailing dot (ASCII/punycode, lowercase).
    pub owner: String,
    /// All distinct typed rewrites for this owner, in deterministic order.
    pub records: Vec<DnsRewrite>,
}

impl DnsRewriteSelection {
    /// Shape this owner's records for one query type.
    ///
    /// `A`, `AAAA` and `CNAME` keep only records of that type. `ANY` is an
    /// explicit operator-rewrite query: it keeps every distinct record of the
    /// owner. Any other query type returns `MatchedEmpty`: the owner matched,
    /// so this is a distinct NODATA outcome and never an ordinary fallback.
    pub fn records_for(&self, qtype: RecordType) -> DnsRewriteRecords {
        let records = match qtype {
            RecordType::A => self.by_type(|value| matches!(value, DnsRewriteValue::A(_))),
            RecordType::AAAA => self.by_type(|value| matches!(value, DnsRewriteValue::Aaaa(_))),
            RecordType::CNAME => self.by_type(|value| matches!(value, DnsRewriteValue::Cname(_))),
            RecordType::ANY => self.records.clone(),
            // Matched owner, unsupported query type: explicit NODATA, not a
            // fall-through to ordinary resolution.
            _ => Vec::new(),
        };
        if records.is_empty() {
            DnsRewriteRecords::MatchedEmpty
        } else {
            DnsRewriteRecords::Matched(records)
        }
    }

    fn by_type(&self, predicate: impl Fn(&DnsRewriteValue) -> bool) -> Vec<DnsRewrite> {
        self.records
            .iter()
            .filter(|rewrite| predicate(&rewrite.value))
            .cloned()
            .collect()
    }
}

/// The result of shaping one matched owner for a query type.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DnsRewriteRecords {
    /// One or more distinct typed records for this query type.
    Matched(Vec<DnsRewrite>),
    /// The owner matched the query name but has no record for this query
    /// type (NODATA), including when the query type is unsupported by this
    /// compiler slice. This is distinct from no owner matching at all.
    MatchedEmpty,
}

/// Lexically validated rule awaiting source attribution in `abp::build`.
pub(crate) struct DnsRewritePlan {
    pub(crate) owner: String,
    pub(crate) value: DnsRewriteValue,
    pub(crate) raw: String,
}

impl DnsRewritePlan {
    pub(crate) fn into_rewrite(self, source_id: &str, line: usize) -> DnsRewrite {
        DnsRewrite {
            owner: self.owner,
            value: self.value,
            evidence: Evidence {
                source_id: source_id.to_owned(),
                source_kind: SourceKind::List,
                rule: bounded_rule(&self.raw),
                note: DNS_REWRITE_NOTE,
            },
            line,
        }
    }
}

/// Parse the value of `$dnsrewrite=...` into the first typed slice.
///
/// Upstream splits on `;` with a limit of three: zero delimiters is a
/// shorthand, one is a syntax error, two is the full `RCODE;RRTYPE;VALUE`
/// form. Extra delimiters can never be part of an A/AAAA/CNAME value, so they
/// are diagnosed here instead of being silently absorbed.
pub(crate) fn parse_value(raw: &str) -> Result<DnsRewriteValue, (DiagnosticKind, String)> {
    if raw.is_empty() {
        return Err((
            DiagnosticKind::Unsupported,
            "empty dnsrewrite value (NODATA/allowlist form) is not in this slice".to_owned(),
        ));
    }
    if raw.len() > MAX_RULE_LEN {
        return Err((
            DiagnosticKind::Unsupported,
            "dnsrewrite value exceeds the bounded rule length".to_owned(),
        ));
    }
    let parts: Vec<&str> = raw.split(';').collect();
    match parts.len() {
        1 => parse_shorthand(raw),
        2 => Err((
            DiagnosticKind::Unsupported,
            "dnsrewrite needs zero or two ; delimiters".to_owned(),
        )),
        3 => parse_full(parts[0], parts[1], parts[2]),
        _ => Err((
            DiagnosticKind::Unsupported,
            "dnsrewrite value has too many ; delimiters".to_owned(),
        )),
    }
}

fn parse_shorthand(raw: &str) -> Result<DnsRewriteValue, (DiagnosticKind, String)> {
    // Upstream classifies an all-uppercase ASCII token as a response-code
    // keyword before trying IP or hostname forms. Those codes are a later
    // slice, so they are reported honestly rather than becoming a rewrite.
    if raw.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return Err((
            DiagnosticKind::Unsupported,
            format!("dnsrewrite response code {raw} is not in this slice"),
        ));
    }
    match raw.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => Ok(DnsRewriteValue::A(ip)),
        Ok(IpAddr::V6(ip)) => Ok(DnsRewriteValue::Aaaa(ip)),
        Err(_) => {
            let target = canonical::canonical_list_name(raw)
                .map_err(|reason| (DiagnosticKind::Malformed, format!("invalid shorthand CNAME target: {reason}")))?;
            Ok(DnsRewriteValue::Cname(target))
        }
    }
}

fn parse_full(
    rcode: &str,
    rrtype: &str,
    value: &str,
) -> Result<DnsRewriteValue, (DiagnosticKind, String)> {
    if !rcode.eq_ignore_ascii_case("NOERROR") {
        return Err((
            DiagnosticKind::Unsupported,
            format!("dnsrewrite response code {rcode} is not in this slice"),
        ));
    }
    if rrtype.eq_ignore_ascii_case("A") {
        let ip = value.parse::<Ipv4Addr>().map_err(|_| {
            (
                DiagnosticKind::Malformed,
                "NOERROR;A needs a valid IPv4 literal".to_owned(),
            )
        })?;
        Ok(DnsRewriteValue::A(ip))
    } else if rrtype.eq_ignore_ascii_case("AAAA") {
        let ip = value.parse::<Ipv6Addr>().map_err(|_| {
            (
                DiagnosticKind::Malformed,
                "NOERROR;AAAA needs a valid IPv6 literal".to_owned(),
            )
        })?;
        Ok(DnsRewriteValue::Aaaa(ip))
    } else if rrtype.eq_ignore_ascii_case("CNAME") {
        let target = canonical::canonical_list_name(value)
            .map_err(|reason| (DiagnosticKind::Malformed, format!("invalid CNAME target: {reason}")))?;
        Ok(DnsRewriteValue::Cname(target))
    } else if rrtype.is_empty() && value.is_empty() {
        Err((
            DiagnosticKind::Unsupported,
            "NOERROR with an empty RR type and value is not in this slice".to_owned(),
        ))
    } else {
        Err((
            DiagnosticKind::Unsupported,
            format!("dnsrewrite RR type {rrtype} is not in this slice"),
        ))
    }
}

/// Owner suffixes of a canonical host, from most to least specific. Walking
/// label boundaries here means no rule is ever scanned per query: each step
/// is one bounded index lookup, and lookalikes never reach an owner key.
fn owner_suffixes(host: &str) -> impl Iterator<Item = &str> {
    std::iter::once(host).chain(
        host.match_indices('.')
            .map(|(index, _)| &host[index + 1..]),
    )
}

/// Immutable compiled rewrite index.
pub(crate) struct DnsRewriteEngine {
    /// Canonical owner -> accepted rewrites, sorted by (source id, line).
    by_owner: BTreeMap<String, Vec<DnsRewrite>>,
    /// Canonical owners of accepted `@@||host^` list exceptions. An exception
    /// suppresses rewrites for its owner and subdomains; it is never an allow
    /// against the household policy owned by the worker.
    exceptions: BTreeSet<String>,
}

/// Build the index and reject conflicting owner data before publication.
pub(crate) fn build(
    rewrites: Vec<DnsRewrite>,
    exceptions: Vec<String>,
    limits: &Limits,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<DnsRewriteEngine, CompileError> {
    let mut by_owner: BTreeMap<String, Vec<DnsRewrite>> = BTreeMap::new();
    for rewrite in rewrites {
        by_owner
            .entry(rewrite.owner.clone())
            .or_default()
            .push(rewrite);
    }

    for (owner, rules) in by_owner.iter_mut() {
        let cname_count = rules
            .iter()
            .filter(|rule| matches!(rule.value, DnsRewriteValue::Cname(_)))
            .count();
        if cname_count > 0 && cname_count < rules.len() {
            push_fatal(
                diagnostics,
                limits,
                Diagnostic::new(
                    &rules[0].evidence.source_id,
                    rules[0].line,
                    DiagnosticKind::Malformed,
                    format!("conflicting dnsrewrite targets for owner {owner}: CNAME and address rules cannot coexist"),
                ),
            );
            return Err(CompileError::Rejected(diagnostics.clone()));
        }
        if cname_count > 1 {
            let distinct: BTreeSet<&DnsRewriteValue> =
                rules.iter().map(|rule| &rule.value).collect();
            if distinct.len() > 1 {
                push_fatal(
                    diagnostics,
                    limits,
                    Diagnostic::new(
                        &rules[0].evidence.source_id,
                        rules[0].line,
                        DiagnosticKind::Malformed,
                        format!("conflicting dnsrewrite targets for owner {owner}: multiple CNAMEs"),
                    ),
                );
                return Err(CompileError::Rejected(diagnostics.clone()));
            }
        }
        // Deterministic selection: source id, then source line. Exact
        // duplicates collapse to one record with the first provenance; every
        // distinct typed value for the owner is retained as a record set, so
        // multiple A/AAAA values are all preserved for later query shaping.
        rules.sort_by(|left, right| {
            left.evidence
                .source_id
                .cmp(&right.evidence.source_id)
                .then(left.line.cmp(&right.line))
        });
        let mut seen: BTreeSet<DnsRewriteValue> = BTreeSet::new();
        rules.retain(|rule| seen.insert(rule.value.clone()));
    }

    Ok(DnsRewriteEngine {
        by_owner,
        exceptions: exceptions.into_iter().collect(),
    })
}

impl DnsRewriteEngine {
    /// Whether an accepted list exception covers this host or any parent at a
    /// label boundary. Callers use this to suppress a list-layer rewrite
    /// without turning the exception into a household allow.
    pub(crate) fn has_exception(&self, host: &str) -> bool {
        owner_suffixes(host).any(|owner| self.exceptions.contains(owner))
    }

    /// Select the typed record set for a canonical host. The most specific
    /// owner wins; all distinct records for that owner are retained in
    /// deterministic `(source id, line)` order. Any matching list exception
    /// suppresses the selection. Owner lookup walks only label boundaries, so
    /// there is no whole-rule scan per query.
    pub(crate) fn select(&self, host: &str) -> Option<(&str, &[DnsRewrite])> {
        if self.has_exception(host) {
            return None;
        }
        for owner in owner_suffixes(host) {
            if let Some((key, rules)) = self.by_owner.get_key_value(owner) {
                // Both the owner and the records are borrowed from the index,
                // so they share the snapshot's lifetime.
                return Some((key.as_str(), rules.as_slice()));
            }
        }
        None
    }
}

fn push_fatal(diagnostics: &mut Vec<Diagnostic>, limits: &Limits, diagnostic: Diagnostic) {
    if limits.max_diagnostics > 0 && diagnostics.len() >= limits.max_diagnostics {
        diagnostics.pop();
    }
    if diagnostics.len() < limits.max_diagnostics {
        diagnostics.push(diagnostic);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn parse_value_typed_and_shorthand_forms() {
        assert_eq!(
            parse_value("192.0.2.1").unwrap(),
            DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 1))
        );
        assert_eq!(
            parse_value("NOERROR;AAAA;2001:db8::1").unwrap(),
            DnsRewriteValue::Aaaa("2001:db8::1".parse().unwrap())
        );
        assert_eq!(
            parse_value("NOERROR;CNAME;Target.Example").unwrap(),
            DnsRewriteValue::Cname("target.example".to_owned())
        );
        assert_eq!(
            parse_value("bücher.example").unwrap(),
            DnsRewriteValue::Cname("xn--bcher-kva.example".to_owned())
        );
        assert_eq!(
            parse_value("REFUSED").unwrap_err().0,
            DiagnosticKind::Unsupported
        );
        assert_eq!(
            parse_value("NOERROR;TXT;hello").unwrap_err().0,
            DiagnosticKind::Unsupported
        );
    }

    #[test]
    fn owner_suffixes_stop_at_label_boundaries() {
        let suffixes: Vec<&str> = owner_suffixes("a.b.example.com").collect();
        assert_eq!(
            suffixes,
            ["a.b.example.com", "b.example.com", "example.com", "com"]
        );
    }
}
