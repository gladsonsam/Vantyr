//! Real-backend tests: Hickory blocklist matching, `adblock` domain rules and
//! bounded hostname regex rules. All fixtures are synthetic and local; no live
//! feed or HTTP is involved.

use std::str::FromStr;

use hickory_server::proto::rr::{Name, RecordType};
use vantyr_network_filter::{
    compile, compile_with_limits, CompileError, DiagnosticKind, FilterOutcome, Limits, ListFormat,
    ListSource, ServiceCatalog, ServiceDefinition, ServiceDomain,
};

fn name(value: &str) -> Name {
    Name::from_str(value).expect("valid test name")
}

fn hosts_source<'a>(id: &str, text: &'a [u8]) -> ListSource<'a> {
    ListSource {
        id: id.to_owned(),
        format: ListFormat::Hosts,
        bytes: text,
        source_url: None,
    }
}

fn abp_source<'a>(id: &str, text: &'a [u8]) -> ListSource<'a> {
    ListSource {
        id: id.to_owned(),
        format: ListFormat::Abp,
        bytes: text,
        source_url: None,
    }
}

#[test]
fn hosts_exact_wildcard_address_prefixes_and_label_boundaries() {
    const TEXT: &[u8] = b"\
# a comment
example.com
0.0.0.0 blocked.test
127.0.0.1 hosts.test
::1 v6.test
*.wild.test
localhost
example.com
";
    let snapshot = compile(7, &[hosts_source("hosts", TEXT)], None, &[]).unwrap();
    assert_eq!(snapshot.revision(), 7);
    assert_eq!(
        snapshot.lists()[0].accepted_rules,
        5,
        "duplicates are deduplicated upstream"
    );

    for blocked in [
        "example.com.",
        "blocked.test.",
        "hosts.test.",
        "v6.test.",
        "a.wild.test.",
    ] {
        assert_eq!(
            snapshot.evaluate(&name(blocked), RecordType::A),
            FilterOutcome::Block {
                evidence: vantyr_network_filter::Evidence {
                    source_id: "hosts".to_owned(),
                    source_kind: vantyr_network_filter::SourceKind::List,
                    rule: None,
                    note: "upstream blocklist exposes no matched entry; list id is authoritative",
                }
            },
            "{blocked} must be blocked"
        );
    }
    for allowed in [
        "www.example.com.",
        "notexample.com.",
        "wild.test.",
        "a.wild.test.evil.test.",
        "localhost.",
    ] {
        assert_eq!(
            snapshot.evaluate(&name(allowed), RecordType::A),
            FilterOutcome::NoMatch,
            "{allowed} must not match a different label boundary"
        );
    }
}

#[test]
fn canonicalisation_and_explicit_query_types() {
    const TEXT: &[u8] = "bücher.example\n0.0.0.0 Mixed.Case.TEST\n".as_bytes();
    let snapshot = compile(1, &[hosts_source("idna", TEXT)], None, &[]).unwrap();
    for blocked in [
        "bücher.example.",
        "xn--bcher-kva.example.",
        "MIXED.case.test.",
    ] {
        assert!(
            matches!(
                snapshot.evaluate(&name(blocked), RecordType::A),
                FilterOutcome::Block { .. }
            ),
            "{blocked} must canonicalise to a blocked host"
        );
    }
    for qtype in [RecordType::A, RecordType::AAAA, RecordType::CNAME] {
        assert!(matches!(
            snapshot.evaluate(&name("bücher.example."), qtype),
            FilterOutcome::Block { .. }
        ));
    }
    for qtype in [RecordType::TXT, RecordType::MX, RecordType::HTTPS] {
        assert_eq!(
            snapshot.evaluate(&name("bücher.example."), qtype),
            FilterOutcome::NoMatch,
            "unsupported query types must not gain list semantics"
        );
    }
}

#[test]
fn invalid_utf8_empty_and_malformed_candidates_are_rejected() {
    let bad_utf8 = [0x66, 0x6f, 0x6f, 0xff];
    assert!(matches!(
        compile(1, &[hosts_source("bad", &bad_utf8)], None, &[]),
        Err(CompileError::InvalidInput(_))
    ));

    assert!(matches!(
        compile(1, &[hosts_source("empty", b"\n# only comments\n")], None, &[]),
        Err(CompileError::Rejected(ref diagnostics))
            if diagnostics.iter().any(|d| d.kind == DiagnosticKind::EmptySource)
    ));

    for malformed in [b"bad..name\n".as_slice(), b"*.com\n".as_slice()] {
        match compile(1, &[hosts_source("bad", malformed)], None, &[]) {
            Err(CompileError::Rejected(diagnostics)) => assert!(
                diagnostics
                    .iter()
                    .any(|d| d.kind == DiagnosticKind::Malformed),
                "expected a malformed diagnostic for {:?}",
                std::str::from_utf8(malformed).unwrap()
            ),
            Ok(_) => panic!("candidate should be rejected"),
            Err(other) => panic!("unexpected error: {other:?}"),
        }
    }
}

#[test]
fn bounds_duplicate_ids_and_determinism() {
    const A: &[u8] = b"a.example\n";
    const B: &[u8] = b"b.example\n";
    let limited = Limits {
        max_lists: 1,
        ..Limits::default()
    };
    assert!(matches!(
        compile_with_limits(
            1,
            &[hosts_source("a", A), hosts_source("b", B)],
            None,
            &[],
            &limited
        ),
        Err(CompileError::Limit(_))
    ));

    let tiny = Limits {
        max_rules: 1,
        max_total_bytes: 64,
        ..Limits::default()
    };
    assert!(matches!(
        compile_with_limits(
            1,
            &[hosts_source("a", A), hosts_source("b", B)],
            None,
            &[],
            &tiny
        ),
        Err(CompileError::Limit(_))
    ));

    let duplicate = compile(
        1,
        &[hosts_source("same", A), hosts_source("same", B)],
        None,
        &[],
    );
    assert!(matches!(duplicate, Err(CompileError::InvalidInput(_))));

    let forward = compile(9, &[hosts_source("a", A), hosts_source("b", B)], None, &[]).unwrap();
    let reverse = compile(9, &[hosts_source("b", B), hosts_source("a", A)], None, &[]).unwrap();
    assert_eq!(forward.lists(), reverse.lists(), "metadata is sorted by id");
    for blocked in ["a.example.", "b.example."] {
        assert_eq!(
            forward.evaluate(&name(blocked), RecordType::A),
            reverse.evaluate(&name(blocked), RecordType::A)
        );
    }
}

#[test]
fn source_url_is_metadata_only() {
    let source = ListSource {
        id: "meta".to_owned(),
        format: ListFormat::Hosts,
        bytes: b"meta.test\n",
        source_url: Some("https://lists.invalid/block.txt".to_owned()),
    };
    let snapshot = compile(1, &[source], None, &[]).unwrap();
    assert_eq!(
        snapshot.lists()[0].source_url.as_deref(),
        Some("https://lists.invalid/block.txt")
    );
    assert!(matches!(
        snapshot.evaluate(&name("meta.test."), RecordType::A),
        FilterOutcome::Block { .. }
    ));
}

#[test]
fn abp_domain_rules_exception_and_upstream_important_precedence() {
    const TEXT: &[u8] = b"\
! list comment
||ads.example^
@@||ads.example^
||video.test^
||promo.test^
@@||promo.test^
||ads.example^$important
";
    let snapshot = compile(3, &[abp_source("abp", TEXT)], None, &[]).unwrap();

    let important = snapshot.evaluate(&name("ads.example."), RecordType::A);
    match important {
        FilterOutcome::Block { evidence } => {
            assert_eq!(evidence.source_id, "abp");
            assert_eq!(evidence.rule.as_deref(), Some("||ads.example^$important"));
            assert!(evidence.note.contains("important"));
        }
        other => panic!("important must win over @@: {other:?}"),
    }
    match snapshot.evaluate(&name("promo.test."), RecordType::A) {
        FilterOutcome::AllowException { evidence } => {
            assert_eq!(evidence.rule.as_deref(), Some("@@||promo.test^"));
        }
        other => panic!("exception must allow within the list layer: {other:?}"),
    }
    match snapshot.evaluate(&name("sub.video.test."), RecordType::A) {
        FilterOutcome::Block { evidence } => {
            assert_eq!(evidence.rule.as_deref(), Some("||video.test^"));
        }
        other => panic!("plain domain rule must block: {other:?}"),
    }
    for allowed in [
        "notvideo.test.",
        "video.test.evil.test.",
        "ads.example.evil.test.",
    ] {
        assert_eq!(
            snapshot.evaluate(&name(allowed), RecordType::A),
            FilterOutcome::NoMatch,
            "{allowed} is a deceptive suffix"
        );
    }
}

#[test]
fn unsupported_abp_rules_are_diagnosed_not_silently_matched() {
    const PREFIX: &[u8] = b"||clean.test^\n";
    let rejected: [&[u8]; 8] = [
        b"||ads.example^\n@@||ads.example^\n||ads.example^$third-party\n",
        b"||ads.example^$script\n",
        b"||ads.example^$image\n",
        b"||ads.example^$dns\n",
        b"||ads.example/path\n",
        b"example.com##.ad\n",
        b"||ads.example\n",
        b"ads.example\n",
    ];
    for (index, extra) in rejected.iter().enumerate() {
        let mut bytes = PREFIX.to_vec();
        bytes.extend_from_slice(extra);
        match compile(1, &[abp_source("abp", &bytes)], None, &[]) {
            Err(CompileError::Rejected(diagnostics)) => assert!(
                diagnostics
                    .iter()
                    .all(|d| d.kind == DiagnosticKind::Unsupported)
                    && !diagnostics.is_empty(),
                "case {index} must report Unsupported only"
            ),
            Ok(_) => panic!("case {index} must be rejected"),
            Err(other) => panic!("case {index}: unexpected error {other:?}"),
        }
    }
}

#[test]
fn abp_exception_does_not_weaken_a_hosts_block_into_an_allow() {
    let snapshot = compile(
        1,
        &[
            hosts_source("hosts", b"both.test\n"),
            abp_source("abp", b"||both.test^\n@@||both.test^\n||clean.test^\n"),
        ],
        None,
        &[],
    )
    .unwrap();
    let outcome = snapshot.evaluate(&name("both.test."), RecordType::A);
    assert!(
        matches!(outcome, FilterOutcome::AllowException { .. }),
        "list-layer exception stays an AllowException, never a grant against baseline"
    );
    let metadata = snapshot.lists();
    assert_eq!(metadata[0].id, "abp");
    assert_eq!(metadata[1].id, "hosts");
    assert_eq!(metadata.len(), 2);
}

#[test]
fn hostname_regex_anchors_case_trailing_dot_and_idna() {
    const TEXT: &[u8] = b"\
/^ads\\.example$/
/^xn--bcher-kva\\.example$/
/^http:\\/\\//
/^catalog\\.test\\/$/
/unanchored\\.test/
";
    let snapshot = compile(3, &[abp_source("rx", TEXT)], None, &[]).unwrap();

    match snapshot.evaluate(&name("ads.example."), RecordType::A) {
        FilterOutcome::Block { evidence } => {
            assert_eq!(evidence.source_id, "rx");
            assert_eq!(
                evidence.source_kind,
                vantyr_network_filter::SourceKind::List
            );
            assert_eq!(evidence.rule.as_deref(), Some("/^ads\\.example$/"));
            assert_eq!(evidence.note, "hostname regex rule");
        }
        other => panic!("anchored regex must block: {other:?}"),
    }
    for blocked in [
        "ADS.Example.",
        "ads.example",
        "bücher.example.",
        "XN--BCHER-KVA.EXAMPLE.",
        "foo.unanchored.test.",
        "unanchored.test.evil.test.",
    ] {
        assert!(
            matches!(
                snapshot.evaluate(&name(blocked), RecordType::A),
                FilterOutcome::Block { .. }
            ),
            "{blocked} must match a canonical hostname regex"
        );
    }
    for allowed in [
        "sub.ads.example.",
        "ads.example.evil.test.",
        "catalog.test.",
        "plain.test.",
    ] {
        assert_eq!(
            snapshot.evaluate(&name(allowed), RecordType::A),
            FilterOutcome::NoMatch,
            "{allowed} must not match an anchored regex or a URL-shaped pattern"
        );
    }
    for qtype in [RecordType::A, RecordType::AAAA, RecordType::CNAME] {
        assert!(matches!(
            snapshot.evaluate(&name("ads.example."), qtype),
            FilterOutcome::Block { .. }
        ));
    }
    assert_eq!(
        snapshot.evaluate(&name("ads.example."), RecordType::TXT),
        FilterOutcome::NoMatch,
        "regex rules must not add semantics to unsupported query types"
    );
}

#[test]
fn hostname_regex_block_exception_and_important_precedence() {
    const TEXT: &[u8] = b"\
||ads.example^
/^ads\\.example$/
@@/^rewards\\.ads\\.example$/
/^video\\.test$/$important
@@/^video\\.test$/
||news.test^$important
@@/^news\\.test$/
/^promo\\.test$/
@@/^promo\\.test$/
";
    let snapshot = compile(4, &[abp_source("abp", TEXT)], None, &[]).unwrap();

    match snapshot.evaluate(&name("ads.example."), RecordType::A) {
        FilterOutcome::Block { evidence } => {
            // On an equal rank the already-accepted domain rule wins.
            assert_eq!(evidence.rule.as_deref(), Some("||ads.example^"));
        }
        other => panic!("plain block must win with stable evidence: {other:?}"),
    }
    match snapshot.evaluate(&name("rewards.ads.example."), RecordType::A) {
        FilterOutcome::AllowException { evidence } => {
            assert_eq!(
                evidence.rule.as_deref(),
                Some("@@/^rewards\\.ads\\.example$/")
            );
        }
        other => panic!("regex exception must beat a plain domain block: {other:?}"),
    }
    match snapshot.evaluate(&name("video.test."), RecordType::A) {
        FilterOutcome::Block { evidence } => {
            assert_eq!(evidence.rule.as_deref(), Some("/^video\\.test$/$important"));
            assert!(evidence.note.contains("important"));
        }
        other => panic!("important regex block must beat an exception: {other:?}"),
    }
    match snapshot.evaluate(&name("news.test."), RecordType::A) {
        FilterOutcome::Block { evidence } => {
            assert_eq!(evidence.rule.as_deref(), Some("||news.test^$important"));
        }
        other => panic!("important domain block must beat a regex exception: {other:?}"),
    }
    match snapshot.evaluate(&name("promo.test."), RecordType::A) {
        FilterOutcome::AllowException { evidence } => {
            assert_eq!(evidence.rule.as_deref(), Some("@@/^promo\\.test$/"));
        }
        other => panic!("regex exception must beat a regex block: {other:?}"),
    }
    assert_eq!(
        snapshot.evaluate(&name("video.test.evil.test."), RecordType::A),
        FilterOutcome::NoMatch,
        "anchors stay relative to the whole hostname"
    );
}

#[test]
fn invalid_and_unbounded_regex_rules_are_diagnosed() {
    fn rejected(extra: &str, kind: DiagnosticKind, needle: &str) {
        let mut bytes = b"||ok.test^\n".to_vec();
        bytes.extend_from_slice(extra.as_bytes());
        bytes.push(b'\n');
        match compile(1, &[abp_source("abp", &bytes)], None, &[]) {
            Err(CompileError::Rejected(diagnostics)) => assert!(
                diagnostics
                    .iter()
                    .any(|d| d.kind == kind && d.detail.contains(needle)),
                "expected {kind:?} containing {needle:?}: {diagnostics:?}"
            ),
            other => panic!("expected bounded rejection: {other:?}"),
        }
    }

    rejected("/[/", DiagnosticKind::Malformed, "regex compile error");
    rejected("//", DiagnosticKind::Malformed, "empty");
    rejected(
        "/unterminated",
        DiagnosticKind::Malformed,
        "closing delimiter",
    );
    rejected(
        "/foo/$third-party",
        DiagnosticKind::Unsupported,
        "$third-party",
    );
    rejected(
        "@@/foo/$important",
        DiagnosticKind::Unsupported,
        "important exceptions",
    );
    rejected(
        "/foo/bar",
        DiagnosticKind::Malformed,
        "followed by modifiers",
    );
    rejected(
        &format!("/{}/", "a".repeat(201)),
        DiagnosticKind::Limit("regex pattern length".to_owned()),
        "bounded length",
    );

    let mut deep = String::from("/");
    deep.push_str(&"(".repeat(40));
    deep.push('a');
    deep.push_str(&")".repeat(40));
    deep.push('/');
    rejected(&deep, DiagnosticKind::Malformed, "regex compile error");
}

#[test]
fn regex_evidence_is_deterministic_across_source_order() {
    const A: &[u8] = b"||a.example^\n";
    const B: &[u8] = b"/^b\\.example$/\n";
    let forward = compile(1, &[abp_source("a", A), abp_source("b", B)], None, &[]).unwrap();
    let reverse = compile(1, &[abp_source("b", B), abp_source("a", A)], None, &[]).unwrap();
    for snapshot in [&forward, &reverse] {
        match snapshot.evaluate(&name("b.example."), RecordType::A) {
            FilterOutcome::Block { evidence } => {
                assert_eq!(evidence.source_id, "b");
                assert_eq!(evidence.rule.as_deref(), Some("/^b\\.example$/"));
            }
            other => panic!("regex evidence must be stable: {other:?}"),
        }
    }
    assert_eq!(forward.lists()[1].accepted_rules, 1);
}

#[test]
fn regex_exceptions_never_override_a_hard_block() {
    let snapshot = compile(
        1,
        &[
            hosts_source("hosts", b"both.test\n"),
            abp_source("abp", b"@@/^both\\.test$/\n/^other\\.test$/\n"),
        ],
        None,
        &[],
    )
    .unwrap();
    assert!(matches!(
        snapshot.evaluate(&name("both.test."), RecordType::A),
        FilterOutcome::AllowException { .. }
    ));

    let catalog = ServiceCatalog {
        version: "1".to_owned(),
        services: vec![ServiceDefinition {
            id: "svc".to_owned(),
            label: "svc".to_owned(),
            domains: vec![ServiceDomain::Suffix("served.test".to_owned())],
            version: "1".to_owned(),
            source: None,
            evidence: None,
        }],
    };
    let snapshot = compile(
        2,
        &[abp_source(
            "abp",
            b"@@/^served\\.test$/\n/^unrelated\\.test$/\n",
        )],
        Some(&catalog),
        &["svc".to_owned()],
    )
    .unwrap();
    match snapshot.evaluate(&name("served.test."), RecordType::A) {
        FilterOutcome::Block { evidence } => assert_eq!(evidence.source_id, "svc"),
        other => panic!("a service block must outrank a regex exception: {other:?}"),
    }
}
