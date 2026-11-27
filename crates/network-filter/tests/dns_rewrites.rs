//! Real-compiler tests for the bounded typed `$dnsrewrite` record-set slice.
//! All fixtures are synthetic and local: this crate builds no DNS response and
//! enforces nothing. These tests only cover the immutable typed compiler
//! contract, including owner-level record-set selection and per-query shaping.

use std::net::{Ipv4Addr, Ipv6Addr};
use std::str::FromStr;

use hickory_server::proto::rr::{Name, RecordType};
use vantyr_network_filter::{
    compile, compile_with_limits, CompileError, DiagnosticKind, DnsRewriteRecords,
    DnsRewriteSelection, DnsRewriteValue, FilterOutcome, FilterSnapshot, Limits, ListFormat,
    ListSource,
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

/// Owner-level selection (no query type). `None` means no owner matched or a
/// list-layer exception suppressed the selection.
fn selection(snapshot: &FilterSnapshot, host: &str) -> Option<DnsRewriteSelection> {
    snapshot.select_dns_rewrite(&name(host))
}

/// Three-way test view of shaping: `None` means no owner matched (ordinary
/// fallback); `Some(vec![])` is a matched owner with no record for the query
/// type (NODATA); `Some(values)` is a matched record set for that type.
fn records_for(
    snapshot: &FilterSnapshot,
    host: &str,
    qtype: RecordType,
) -> Option<Vec<DnsRewriteValue>> {
    let selected = selection(snapshot, host)?;
    Some(match selected.records_for(qtype) {
        DnsRewriteRecords::Matched(records) => {
            records.into_iter().map(|record| record.value).collect()
        }
        DnsRewriteRecords::MatchedEmpty => Vec::new(),
    })
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
        (
            "a.example.",
            RecordType::A,
            DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 10)),
        ),
        (
            "b.example.",
            RecordType::AAAA,
            DnsRewriteValue::Aaaa(Ipv6Addr::from_str("2001:db8::10").unwrap()),
        ),
        (
            "c.example.",
            RecordType::CNAME,
            DnsRewriteValue::Cname("target.example".to_owned()),
        ),
        (
            "d.example.",
            RecordType::A,
            DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 20)),
        ),
        (
            "e.example.",
            RecordType::AAAA,
            DnsRewriteValue::Aaaa(Ipv6Addr::from_str("2001:db8::20").unwrap()),
        ),
        (
            "f.example.",
            RecordType::CNAME,
            DnsRewriteValue::Cname("target.example".to_owned()),
        ),
    ];
    for (host, qtype, value) in expected {
        assert_eq!(
            records_for(&snapshot, host, qtype),
            Some(vec![value.clone()]),
            "{host} typed value"
        );
        let selected = selection(&snapshot, host).unwrap();
        assert_eq!(selected.owner, host.trim_end_matches('.'));
        match selected.records_for(qtype) {
            DnsRewriteRecords::Matched(records) => {
                assert_eq!(records.len(), 1);
                assert_eq!(records[0].value, value);
                assert_eq!(records[0].evidence.source_id, "abp");
                assert!(records[0]
                    .evidence
                    .rule
                    .as_deref()
                    .unwrap_or_default()
                    .contains("$dnsrewrite"));
            }
            DnsRewriteRecords::MatchedEmpty => panic!("{host} must have a typed record"),
        }
        assert_eq!(
            snapshot.evaluate(&name(host), qtype),
            FilterOutcome::NoMatch,
            "a rewrite is not a block"
        );
    }
    assert_eq!(selection(&snapshot, "none.example."), None);
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
            selection(&snapshot, host).map(|selected| selected.owner),
            Some("example.com".to_owned()),
            "{host} uses the documented domain + subdomain owner"
        );
        assert_eq!(
            records_for(&snapshot, host, RecordType::A),
            Some(vec![DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 1))]),
            "{host} inherits the least-specific matching owner's A record"
        );
    }
    for host in ["mail.example.com.", "x.mail.example.com."] {
        assert_eq!(
            selection(&snapshot, host).map(|selected| selected.owner),
            Some("mail.example.com".to_owned()),
            "{host} prefers the most specific owner"
        );
        assert_eq!(
            records_for(&snapshot, host, RecordType::A),
            Some(vec![DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 2))])
        );
    }
    assert_eq!(
        records_for(&snapshot, "a.cdn.example.net.", RecordType::CNAME),
        Some(vec![DnsRewriteValue::Cname("edge.example".to_owned())])
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
            selection(&snapshot, lookalike),
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
        let selected = selection(&snapshot, host).unwrap_or_else(|| panic!("{host} must select"));
        assert_eq!(selected.owner, "xn--bcher-kva.example");
        assert_eq!(
            records_for(&snapshot, host, RecordType::CNAME),
            Some(vec![DnsRewriteValue::Cname("ziel.example".to_owned())])
        );
    }
    assert_eq!(
        records_for(&snapshot, "idn.example.", RecordType::CNAME),
        Some(vec![DnsRewriteValue::Cname("xn--bcher-kva.test".to_owned())])
    );
    // The same canonical owner written as punycode in this source is a
    // separate rule for a different owner, typed by its own value.
    assert_eq!(
        records_for(&snapshot, "xn--bcher-kva.test.", RecordType::A),
        Some(vec![DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 7))])
    );
}

#[test]
fn multiple_distinct_a_records_are_all_preserved() {
    const TEXT: &[u8] = b"\
||multi.example^$dnsrewrite=192.0.2.2
||multi.example^$dnsrewrite=192.0.2.3
||multi.example^$dnsrewrite=192.0.2.4
";
    let snapshot = compile(1, &[abp_source("abp", TEXT)], None, &[]).unwrap();
    assert_eq!(snapshot.lists()[0].accepted_rules, 3);
    let expected = Some(vec![
        DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 2)),
        DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 3)),
        DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 4)),
    ]);
    assert_eq!(records_for(&snapshot, "multi.example.", RecordType::A), expected);
    // A subdomain inherits the full record set of the most specific owner.
    assert_eq!(
        records_for(&snapshot, "www.multi.example.", RecordType::A),
        expected
    );
}

#[test]
fn mixed_a_and_aaaa_records_are_all_preserved_and_shaped() {
    const TEXT: &[u8] = b"\
||mixed.example^$dnsrewrite=192.0.2.1
||mixed.example^$dnsrewrite=2001:db8::1
||mixed.example^$dnsrewrite=NOERROR;A;192.0.2.2
||mixed.example^$dnsrewrite=NOERROR;AAAA;2001:db8::2
";
    let snapshot = compile(1, &[abp_source("abp", TEXT)], None, &[]).unwrap();
    assert_eq!(snapshot.lists()[0].accepted_rules, 4);
    let selected = selection(&snapshot, "mixed.example.").unwrap();
    assert_eq!(selected.owner, "mixed.example");
    assert_eq!(selected.records.len(), 4, "all distinct values are retained");
    assert_eq!(
        records_for(&snapshot, "mixed.example.", RecordType::A),
        Some(vec![
            DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 1)),
            DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 2)),
        ])
    );
    assert_eq!(
        records_for(&snapshot, "mixed.example.", RecordType::AAAA),
        Some(vec![
            DnsRewriteValue::Aaaa(Ipv6Addr::from_str("2001:db8::1").unwrap()),
            DnsRewriteValue::Aaaa(Ipv6Addr::from_str("2001:db8::2").unwrap()),
        ])
    );
    assert_eq!(
        records_for(&snapshot, "mixed.example.", RecordType::ANY),
        Some(vec![
            DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 1)),
            DnsRewriteValue::Aaaa(Ipv6Addr::from_str("2001:db8::1").unwrap()),
            DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 2)),
            DnsRewriteValue::Aaaa(Ipv6Addr::from_str("2001:db8::2").unwrap()),
        ])
    );
}

#[test]
fn each_supported_query_type_shapes_only_its_records() {
    const TEXT: &[u8] = b"\
||types.example^$dnsrewrite=192.0.2.1
||types.example^$dnsrewrite=2001:db8::1
||alias.example^$dnsrewrite=NOERROR;CNAME;target.example
";
    let snapshot = compile(1, &[abp_source("abp", TEXT)], None, &[]).unwrap();
    assert_eq!(
        records_for(&snapshot, "types.example.", RecordType::A),
        Some(vec![DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 1))])
    );
    assert_eq!(
        records_for(&snapshot, "types.example.", RecordType::AAAA),
        Some(vec![DnsRewriteValue::Aaaa(
            Ipv6Addr::from_str("2001:db8::1").unwrap()
        )])
    );
    // The owner matched but has no CNAME: NODATA, not an unmatched owner.
    assert_eq!(
        records_for(&snapshot, "types.example.", RecordType::CNAME),
        Some(vec![])
    );
    assert_eq!(
        records_for(&snapshot, "alias.example.", RecordType::CNAME),
        Some(vec![DnsRewriteValue::Cname("target.example".to_owned())])
    );
    assert_eq!(
        records_for(&snapshot, "alias.example.", RecordType::A),
        Some(vec![])
    );
}

#[test]
fn any_query_type_returns_all_distinct_records() {
    const TEXT: &[u8] = b"\
||any.example^$dnsrewrite=192.0.2.1
||any.example^$dnsrewrite=2001:db8::1
||cname.example^$dnsrewrite=NOERROR;CNAME;target.example
";
    let snapshot = compile(1, &[abp_source("abp", TEXT)], None, &[]).unwrap();
    assert_eq!(
        records_for(&snapshot, "any.example.", RecordType::ANY),
        Some(vec![
            DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 1)),
            DnsRewriteValue::Aaaa(Ipv6Addr::from_str("2001:db8::1").unwrap()),
        ])
    );
    assert_eq!(
        records_for(&snapshot, "cname.example.", RecordType::ANY),
        Some(vec![DnsRewriteValue::Cname("target.example".to_owned())])
    );
    assert_eq!(records_for(&snapshot, "none.example.", RecordType::ANY), None);
}

#[test]
fn unmatched_owner_and_matched_empty_are_distinct() {
    const TEXT: &[u8] = b"\
||only-aaaa.example^$dnsrewrite=2001:db8::1
||only-a.example^$dnsrewrite=192.0.2.1
";
    let snapshot = compile(1, &[abp_source("abp", TEXT)], None, &[]).unwrap();

    // No owner matched: ordinary fallback for every query type.
    assert_eq!(selection(&snapshot, "unrelated.example."), None);
    for qtype in [RecordType::A, RecordType::AAAA, RecordType::TXT] {
        assert_eq!(records_for(&snapshot, "unrelated.example.", qtype), None);
    }

    // Owner matched but no A record: explicit NODATA, never ordinary fallback.
    let selected = selection(&snapshot, "only-aaaa.example.").unwrap();
    assert_eq!(selected.owner, "only-aaaa.example");
    assert_eq!(
        selected.records_for(RecordType::A),
        DnsRewriteRecords::MatchedEmpty
    );
    assert_eq!(
        records_for(&snapshot, "only-aaaa.example.", RecordType::A),
        Some(vec![])
    );
    assert_eq!(
        records_for(&snapshot, "only-aaaa.example.", RecordType::AAAA),
        Some(vec![DnsRewriteValue::Aaaa(
            Ipv6Addr::from_str("2001:db8::1").unwrap()
        )])
    );

    // Unsupported query types on a matched owner are also matched-empty.
    for qtype in [RecordType::TXT, RecordType::MX, RecordType::HTTPS] {
        assert_eq!(
            selected.records_for(qtype),
            DnsRewriteRecords::MatchedEmpty,
            "unsupported qtype on a matched owner must be matched-empty"
        );
        assert_eq!(
            records_for(&snapshot, "only-a.example.", qtype),
            Some(vec![])
        );
        assert_eq!(records_for(&snapshot, "unrelated.example.", qtype), None);
    }
}

#[test]
fn duplicates_and_cross_source_provenance_are_deterministic() {
    const DUPLICATES: &[u8] = b"\
||dup.example^$dnsrewrite=192.0.2.1
||dup.example^$dnsrewrite=192.0.2.1
";
    let snapshot = compile(1, &[abp_source("abp", DUPLICATES)], None, &[]).unwrap();
    // Both source lines count toward accepted_rules and the global cap, then
    // collapse to one record with the first line's provenance.
    assert_eq!(snapshot.lists()[0].accepted_rules, 2);
    let selected = selection(&snapshot, "dup.example.").unwrap();
    assert_eq!(selected.records.len(), 1, "exact duplicates collapse");
    assert_eq!(
        selected.records[0].value,
        DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 1))
    );
    assert_eq!(selected.records[0].line, 1, "first line supplies provenance");
    assert_eq!(selected.records[0].evidence.source_id, "abp");

    // Distinct values from two sources are both retained with their own
    // provenance; source id is the primary deterministic key in either input
    // order.
    const A: &[u8] = b"||shared.example^$dnsrewrite=192.0.2.8\n";
    const Z: &[u8] = b"||shared.example^$dnsrewrite=192.0.2.9\n";
    for sources in [
        vec![abp_source("z", Z), abp_source("a", A)],
        vec![abp_source("a", A), abp_source("z", Z)],
    ] {
        let snapshot = compile(1, &sources, None, &[]).unwrap();
        let selected = selection(&snapshot, "sub.shared.example.").unwrap();
        assert_eq!(selected.owner, "shared.example");
        assert_eq!(selected.records.len(), 2);
        assert_eq!(
            selected.records[0].value,
            DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 8))
        );
        assert_eq!(selected.records[0].evidence.source_id, "a");
        assert_eq!(selected.records[0].line, 1);
        assert_eq!(
            selected.records[1].value,
            DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 9))
        );
        assert_eq!(selected.records[1].evidence.source_id, "z");
        assert_eq!(selected.records[1].line, 1);
    }
}

#[test]
fn conflicting_owners_still_reject() {
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
fn list_exceptions_suppress_rewrites_without_granting_household_access() {
    const TEXT: &[u8] = b"\
||example.com^$dnsrewrite=192.0.2.1
@@||example.com^
||other.example^$dnsrewrite=192.0.2.2
@@||sub.other.example^
";
    let snapshot = compile(1, &[abp_source("abp", TEXT)], None, &[]).unwrap();
    for host in ["example.com.", "a.example.com.", "sub.other.example.", "x.sub.other.example."] {
        assert_eq!(selection(&snapshot, host), None, "{host} rewrite is suppressed");
        assert!(
            !matches!(
                snapshot.evaluate(&name(host), RecordType::A),
                FilterOutcome::Block { .. }
            ),
            "{host} must not become a block"
        );
    }
    assert_eq!(
        records_for(&snapshot, "other.example.", RecordType::A),
        Some(vec![DnsRewriteValue::A(Ipv4Addr::new(192, 0, 2, 2))])
    );

    const IMPORTANT: &[u8] = b"\
||important.example^$dnsrewrite=192.0.2.3
@@||important.example^$important
";
    let snapshot = compile(1, &[abp_source("abp", IMPORTANT)], None, &[]).unwrap();
    assert_eq!(selection(&snapshot, "important.example."), None);
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
    assert_eq!(selection(&snapshot, "block.example."), None);
    assert_eq!(
        snapshot.evaluate(&name("rewrite.example."), RecordType::A),
        FilterOutcome::NoMatch
    );
    assert!(selection(&snapshot, "rewrite.example.").is_some());
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
    assert!(selection(&mixed, "rewrite.example.").is_some());
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
    let limits = Limits {
        max_dns_rewrites: 3,
        max_diagnostics: 1,
        ..Limits::default()
    };
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

    // The cap is global and charges duplicates: two sources cannot each spend
    // the full allowance.
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
fn no_rewrite_without_a_matching_rule() {
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
    assert_eq!(selection(&snapshot, "example.com."), None);
}
