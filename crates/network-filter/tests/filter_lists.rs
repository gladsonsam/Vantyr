//! Real-backend tests: Hickory blocklist matching and `adblock` domain rules.
//! All fixtures are synthetic and local; no live feed or HTTP is involved.

use std::str::FromStr;

use hickory_server::proto::rr::{Name, RecordType};
use vantyr_network_filter::{
    compile, compile_with_limits, CompileError, DiagnosticKind, FilterOutcome, Limits, ListFormat,
    ListSource,
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
    let rejected: [&[u8]; 9] = [
        b"||ads.example^\n@@||ads.example^\n||ads.example^$third-party\n",
        b"||ads.example^$script\n",
        b"||ads.example^$image\n",
        b"||ads.example^$dns\n",
        b"||ads.example/path\n",
        b"example.com##.ad\n",
        b"/ads.example/\n",
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
