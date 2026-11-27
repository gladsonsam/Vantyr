//! Real-compiler tests for the first typed `$dnsrewrite` slice. All fixtures
//! are synthetic and local: this crate builds no DNS response and enforces
//! nothing. These tests only cover the immutable typed compiler contract.

use std::net::{Ipv4Addr, Ipv6Addr};
use std::str::FromStr;

use hickory_server::proto::rr::{Name, RecordType};
use vantyr_network_filter::{
    compile, compile_with_limits, CompileError, DiagnosticKind, DnsRewrite, DnsRewriteValue,
    FilterOutcome, Limits, ListFormat, ListSource,
};

fn name(value: &str) -> Name {
    Name::from_str(value).expect("valid test name")
}

fn abp_source<'a>(id: &str, text: &'a [u8]) -> ListSource<'a> {
    ListSource {
        id: id.to_owned(),
        format: ListFormat::Abp,
        bytes: text,
        source_url: None,
    }
}

fn hosts_source<'a>(id: &str, text: &'a [u8]) -> ListSource<'a> {
    ListSource {
        id: id.to_owned(),
        format: ListFormat::Hosts,
        bytes: text,
        source_url: None,
    }
}

fn selected(snapshot: &vantyr_network_filter::FilterSnapshot, host: &str) -> Option<DnsRewrite> {
    snapshot.select_dns_rewrite(&name(host), RecordType::A)
}

#[test]
fn typed_forms_shorthands_and_no_block_semantics() {
    const TEXT: &[u8] = b"\
||a.example^$dnsrewrite=NOERROR;A;192.0.2.10
||b.example^$dnsrewrite=NOERROR;AAAA;2001:db8::10
||c.example^$dnsrewrite=NOERROR;CNAME;target.example
||d.example^$dnsrewrite=192.0.2.20
||e.example^$dnsrewrite=2001:db8::20
||f.example^$dnsrewrite=target.example
";
    let snapshot = compile(1, &[abp_source("abp", TEXT)], None, &[]).unwrap();
    assert_eq!(snapshot.lists()[0].accepted_rules, 6);

    let expected = [
        ("a.example.", DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 10))),
        (
            "b.example.",
            DnsRewriteValue::Aaaa(Ipv6Addr::from_str("2001:db8::10").unwrap()),
        ),
        (
            "c.example.",
            DnsRewriteValue::Cname("target.example".to_owned()),
        ),
        ("d.example.", DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 20))),
        (
            "e.example.",
            DnsRewriteValue::Aaaa(Ipv6Addr::from_str("2001:db8::20").unwrap()),
        ),
        (
            "f.example.",
            DnsRewriteValue::Cname("target.example".to_owned()),
        ),
    ];
    for (host, value) in expected {
        let rewrite = selected(&snapshot, host).unwrap_or_else(|| panic!("{host} must select"));
        assert_eq!(rewrite.value, value, "{host} typed value");
        assert_eq!(rewrite.evidence.source_id, "abp");
        assert!(rewrite
            .evidence
            .rule
            .as_deref()
            .unwrap_or_default()
            .contains("$dnsrewrite"));
        assert_eq!(
            snapshot.evaluate(&name(host), RecordType::A),
            FilterOutcome::NoMatch,
            "a rewrite is not a block"
        );
    }
    assert_eq!(selected(&snapshot, "none.example."), None);
}

#[test]
fn owner_suffix_label_boundaries_lookalikes_and_specificity() {
    const TEXT: &[u8] = b"\
||example.com^$dnsrewrite=192.0.2.1
||mail.example.com^$dnsrewrite=192.0.2.2
||cdn.example.net^$dnsrewrite=NOERROR;CNAME;edge.example
";
    let snapshot = compile(1, &[abp_source("abp", TEXT)], None, &[]).unwrap();

    for host in ["example.com.", "www.example.com.", "a.b.example.com."] {
        assert_eq!(
            selected(&snapshot, host).map(|rewrite| rewrite.value),
            Some(DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 1))),
            "{host} uses the documented domain + subdomain owner"
        );
    }
    for host in ["mail.example.com.", "x.mail.example.com."] {
        assert_eq!(
            selected(&snapshot, host).map(|rewrite| rewrite.value),
            Some(DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 2))),
            "{host} prefers the most specific owner"
        );
    }
    assert_eq!(
        selected(&snapshot, "a.cdn.example.net.").map(|rewrite| rewrite.value),
        Some(DnsRewriteValue::Cname("edge.example".to_owned()))
    );
    for lookalike in [
        "notexample.com.",
        "example.com.evil.test.",
        "examplecom.",
        "example.org.",
        "www.example.net.",
        "cdn.example.net.evil.test.",
    ] {
        assert_eq!(
            selected(&snapshot, lookalike),
            None,
            "{lookalike} must not match a label-boundary suffix"
        );
    }
}

#[test]
fn canonical_unicode_punycode_owners_and_targets() {
    const TEXT: &str = "\
||bücher.example^$dnsrewrite=NOERROR;CNAME;ziel.example
||idn.example^$dnsrewrite=bücher.test
||xn--bcher-kva.test^$dnsrewrite=192.0.2.7
";
    let snapshot = compile(1, &[abp_source("abp", TEXT.as_bytes())], None, &[]).unwrap();
    for host in ["bücher.example.", "xn--bcher-kva.example.", "a.xn--bcher-kva.example."] {
        let rewrite = selected(&snapshot, host).unwrap_or_else(|| panic!("{host} must select"));
        assert_eq!(rewrite.owner, "xn--bcher-kva.example");
        assert_eq!(
            rewrite.value,
            DnsRewriteValue::Cname("ziel.example".to_owned())
        );
    }
    let shorthand = selected(&snapshot, "idn.example.").unwrap();
    assert_eq!(
        shorthand.value,
        DnsRewriteValue::Cname("xn--bcher-kva.test".to_owned())
    );
    // The same canonical owner written as punycode in this source is a
    // separate rule for a different owner, and is typed by its own value.
    assert_eq!(
        selected(&snapshot, "xn--bcher-kva.test.").map(|rewrite| rewrite.value),
        Some(DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 7)))
    );
}

#[test]
fn duplicates_multiple_addresses_and_conflicting_owners() {
    const DUPLICATES: &[u8] = b"\
||dup.example^$dnsrewrite=192.0.2.1
||dup.example^$dnsrewrite=192.0.2.1
||multi.example^$dnsrewrite=192.0.2.2
||multi.example^$dnsrewrite=192.0.2.3
";
    let snapshot = compile(1, &[abp_source("abp", DUPLICATES)], None, &[]).unwrap();
    assert_eq!(snapshot.lists()[0].accepted_rules, 4);
    assert_eq!(
        selected(&snapshot, "dup.example.").map(|rewrite| rewrite.value),
        Some(DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 1)))
    );
    assert_eq!(
        selected(&snapshot, "multi.example.").map(|rewrite| rewrite.value),
        Some(DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 2))),
        "distinct addresses resolve by source id then line"
    );

    for (index, text) in [
        "||mix.example^$dnsrewrite=192.0.2.1\n||mix.example^$dnsrewrite=NOERROR;CNAME;target.example\n",
        "||mix.example^$dnsrewrite=NOERROR;CNAME;one.example\n||mix.example^$dnsrewrite=NOERROR;CNAME;two.example\n",
    ]
    .iter()
    .enumerate()
    {
        match compile(1, &[abp_source("abp", text.as_bytes())], None, &[]) {
            Err(CompileError::Rejected(diagnostics)) => assert!(
                diagnostics.iter().any(|d| d.detail.contains("conflicting")),
                "case {index} must name the conflict"
            ),
            _ => panic!("case {index} must reject conflicting owner data (got Ok)"),
        }
    }
}

#[test]
fn cross_source_selection_is_deterministic_in_both_input_orders() {
    const A: &[u8] = b"||shared.example^$dnsrewrite=192.0.2.8\n";
    const Z: &[u8] = b"||shared.example^$dnsrewrite=192.0.2.9\n";
    for sources in [
        vec![abp_source("z", Z), abp_source("a", A)],
        vec![abp_source("a", A), abp_source("z", Z)],
    ] {
        let snapshot = compile(1, &sources, None, &[]).unwrap();
        let rewrite = selected(&snapshot, "sub.shared.example.").unwrap();
        assert_eq!(rewrite.evidence.source_id, "a");
        assert_eq!(
            rewrite.value,
            DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 8))
        );
    }
}

#[test]
fn list_exceptions_suppress_rewrites_without_granting_household_access() {
    const TEXT: &[u8] = b"\
||example.com^$dnsrewrite=192.0.2.1
@@||example.com^
||other.example^$dnsrewrite=192.0.2.2
@@||sub.other.example^
";
    let snapshot = compile(1, &[abp_source("abp", TEXT)], None, &[]).unwrap();
    for host in ["example.com.", "a.example.com.", "sub.other.example.", "x.sub.other.example."] {
        assert_eq!(selected(&snapshot, host), None, "{host} rewrite is suppressed");
        assert!(
            !matches!(
                snapshot.evaluate(&name(host), RecordType::A),
                FilterOutcome::Block { .. }
            ),
            "{host} must not become a block"
        );
    }
    assert_eq!(
        selected(&snapshot, "other.example.").map(|rewrite| rewrite.value),
        Some(DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 2)))
    );

    const IMPORTANT: &[u8] = b"\
||important.example^$dnsrewrite=192.0.2.3
@@||important.example^$important
";
    let snapshot = compile(1, &[abp_source("abp", IMPORTANT)], None, &[]).unwrap();
    assert_eq!(selected(&snapshot, "important.example."), None);
}

#[test]
fn rewrites_leave_block_and_exception_decisions_unchanged() {
    const TEXT: &[u8] = b"\
||block.example^
||rewrite.example^$dnsrewrite=192.0.2.1
@@||allowed.example^
||allowed.example^
";
    let snapshot = compile(1, &[abp_source("abp", TEXT)], None, &[]).unwrap();
    assert!(matches!(
        snapshot.evaluate(&name("block.example."), RecordType::A),
        FilterOutcome::Block { .. }
    ));
    assert_eq!(selected(&snapshot, "block.example."), None);
    assert_eq!(
        snapshot.evaluate(&name("rewrite.example."), RecordType::A),
        FilterOutcome::NoMatch
    );
    assert!(selected(&snapshot, "rewrite.example.").is_some());
    assert!(matches!(
        snapshot.evaluate(&name("allowed.example."), RecordType::A),
        FilterOutcome::AllowException { .. }
    ));

    let mixed = compile(
        1,
        &[
            hosts_source("hosts", b"rewrite.example\n"),
            abp_source("abp", b"||rewrite.example^$dnsrewrite=192.0.2.1\n"),
        ],
        None,
        &[],
    )
    .unwrap();
    assert!(matches!(
        mixed.evaluate(&name("rewrite.example."), RecordType::A),
        FilterOutcome::Block { .. }
    ));
    assert!(selected(&mixed, "rewrite.example.").is_some());
}

#[test]
fn unsupported_and_malformed_rewrites_are_diagnosed_not_silently_applied() {
    const PREFIX: &str = "||clean.test^$dnsrewrite=192.0.2.1\n";
    const CASES: &[&str] = &[
        "||bad.example^$dnsrewrite=REFUSED\n",
        "||bad.example^$dnsrewrite=NXDOMAIN\n",
        "||bad.example^$dnsrewrite=NOERROR;;\n",
        "||bad.example^$dnsrewrite=NOERROR;TXT;hello\n",
        "||bad.example^$dnsrewrite=NOERROR;MX;10 mail.example\n",
        "||bad.example^$dnsrewrite=NOERROR;A;nope\n",
        "||bad.example^$dnsrewrite=NOERROR;AAAA;192.0.2.1\n",
        "||bad.example^$dnsrewrite=NOERROR;CNAME;*.example.com\n",
        "@@||bad.example^$dnsrewrite=192.0.2.1\n",
        "@@||bad.example^$dnsrewrite\n",
        "||bad.example^$dnsrewrite=192.0.2.1,important\n",
        "||bad.example^$dnsrewrite=192.0.2.1,client=1.2.3.4\n",
        "||bad.example^$dnsrewrite=192.0.2.1,ctag=1\n",
        "||bad.example^$dnsrewrite=192.0.2.1,dnstype=A\n",
        "||bad.example^$dnsrewrite=192.0.2.1,badfilter\n",
        "||*.example.com^$dnsrewrite=192.0.2.1\n",
        "||bad.example^$dnsrewrite=1.2.3.4;x\n",
        "||bad.example^$dnsrewrite=\n",
        "||bad.example^$dnsrewrite=NOERROR;A;1.2.3.4;extra\n",
        "||localhost^$dnsrewrite=192.0.2.1\n",
    ];
    for (index, bad) in CASES.iter().enumerate() {
        let mut bytes = PREFIX.as_bytes().to_vec();
        bytes.extend_from_slice(bad.as_bytes());
        match compile(1, &[abp_source("abp", &bytes)], None, &[]) {
            Err(CompileError::Rejected(diagnostics)) => assert!(
                diagnostics.iter().any(|d| matches!(
                    d.kind,
                    DiagnosticKind::Unsupported | DiagnosticKind::Malformed
                )),
                "case {index} must report an explicit diagnostic: {diagnostics:?}"
            ),
            _ => panic!("case {index} must be rejected (got Ok)"),
        }
    }
}

#[test]
fn global_rewrite_cap_exactly_at_and_over_budget() {
    let mut limits = Limits::default();
    limits.max_dns_rewrites = 3;
    limits.max_diagnostics = 1;
    const EXACT: &str = "\
||a.test^$dnsrewrite=192.0.2.1
||b.test^$dnsrewrite=192.0.2.2
||c.test^$dnsrewrite=NOERROR;CNAME;target.example
";
    assert!(compile_with_limits(
        1,
        &[abp_source("abp", EXACT.as_bytes())],
        None,
        &[],
        &limits
    )
    .is_ok());

    let over = format!("{EXACT}||d.test^$dnsrewrite=192.0.2.4\n");
    match compile_with_limits(
        1,
        &[abp_source("abp", over.as_bytes())],
        None,
        &[],
        &limits,
    ) {
        Err(CompileError::Rejected(diagnostics)) => assert!(
            diagnostics
                .iter()
                .any(|d| d.kind == DiagnosticKind::Limit("dns rewrite count".to_owned())),
            "the fatal bound diagnostic must survive the bounded list: {diagnostics:?}"
        ),
        _ => panic!("overflow must be rejected (got Ok)"),
    }

    // The cap is global: two sources cannot each spend the full allowance.
    match compile_with_limits(
        1,
        &[
            abp_source("a", b"||a.test^$dnsrewrite=192.0.2.1\n||b.test^$dnsrewrite=192.0.2.2\n"),
            abp_source("z", b"||c.test^$dnsrewrite=192.0.2.3\n||d.test^$dnsrewrite=192.0.2.4\n"),
        ],
        None,
        &[],
        &limits,
    ) {
        Err(CompileError::Rejected(diagnostics)) => assert!(
            diagnostics
                .iter()
                .any(|d| d.kind == DiagnosticKind::Limit("dns rewrite count".to_owned()))
        ),
        _ => panic!("cross-source overflow must be rejected (got Ok)"),
    }
}

#[test]
fn no_rewrite_without_rules_or_on_unsupported_query_types() {
    let snapshot = compile(
        1,
        &[
            hosts_source("hosts", b"example.com\n"),
            abp_source("abp", b"||rewrite.example^$dnsrewrite=192.0.2.1\n"),
        ],
        None,
        &[],
    )
    .unwrap();
    assert_eq!(selected(&snapshot, "example.com."), None);
    for qtype in [
        RecordType::TXT,
        RecordType::MX,
        RecordType::HTTPS,
        RecordType::ANY,
    ] {
        assert_eq!(
            snapshot.select_dns_rewrite(&name("rewrite.example."), qtype),
            None,
            "unsupported query types gain no rewrite semantics"
        );
    }
}
