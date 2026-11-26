//! Operator-provided, synthetic service catalog fixtures only. A service is a
//! domain set; it is not an app identity, a URL matcher or a browser category.

use std::str::FromStr;

use hickory_server::proto::rr::{Name, RecordType};
use vantyr_network_filter::{
    compile, compile_with_limits, CompileError, FilterOutcome, Limits, ListFormat, ListSource,
    ServiceCatalog, ServiceDefinition, ServiceDomain, SourceKind,
};

fn name(value: &str) -> Name {
    Name::from_str(value).expect("valid test name")
}

fn catalog() -> ServiceCatalog {
    ServiceCatalog {
        version: "fixture-1".to_owned(),
        services: vec![
            ServiceDefinition {
                id: "video".to_owned(),
                label: "Video domains".to_owned(),
                domains: vec![
                    ServiceDomain::Suffix("video.example".to_owned()),
                    ServiceDomain::Exact("www.news.example".to_owned()),
                ],
                version: "2026-11-01".to_owned(),
                source: Some("operator-provided synthetic fixture".to_owned()),
                evidence: Some("local operator selection".to_owned()),
            },
            ServiceDefinition {
                id: "games".to_owned(),
                label: "Game domains".to_owned(),
                domains: vec![ServiceDomain::Suffix("games.example".to_owned())],
                version: "2026-11-01".to_owned(),
                source: None,
                evidence: None,
            },
            ServiceDefinition {
                id: "unused".to_owned(),
                label: "Not selected".to_owned(),
                domains: vec![ServiceDomain::Suffix("unused.example".to_owned())],
                version: "2026-11-01".to_owned(),
                source: None,
                evidence: None,
            },
        ],
    }
}

#[test]
fn selected_service_blocks_exact_suffix_and_subdomains_with_service_evidence() {
    let selected = vec!["video".to_owned()];
    let snapshot = compile(11, &[], Some(&catalog()), &selected).unwrap();

    for blocked in [
        "video.example.",
        "cdn.video.example.",
        "deep.cdn.video.example.",
        "www.news.example.",
    ] {
        match snapshot.evaluate(&name(blocked), RecordType::A) {
            FilterOutcome::Block { evidence } => {
                assert_eq!(evidence.source_id, "video");
                assert_eq!(evidence.source_kind, SourceKind::Service);
                assert!(
                    evidence.rule.is_none(),
                    "no per-entry upstream evidence is invented"
                );
            }
            other => panic!("{blocked} must be blocked by the selected service: {other:?}"),
        }
    }
    for untouched in [
        "news.example.",
        "notvideo.example.",
        "video.example.evil.test.",
        "games.example.",
        "unused.example.",
    ] {
        assert_eq!(
            snapshot.evaluate(&name(untouched), RecordType::A),
            FilterOutcome::NoMatch,
            "{untouched} must be unchanged"
        );
    }
    assert_eq!(snapshot.services()[0].id, "video");
    assert_eq!(snapshot.services()[0].label, "Video domains");
    assert_eq!(snapshot.services()[0].version, "2026-11-01");
    assert_eq!(
        snapshot.services()[0].source.as_deref(),
        Some("operator-provided synthetic fixture")
    );
}

#[test]
fn overlapping_services_resolve_deterministically_and_no_allow_overrides_them() {
    let mut overlapping = catalog();
    for service in &mut overlapping.services {
        service.domains = vec![ServiceDomain::Suffix("shared.example".to_owned())];
    }
    let both = vec!["z-service".to_owned(), "a-service".to_owned()];
    overlapping.services.push(ServiceDefinition {
        id: "z-service".to_owned(),
        label: "Z".to_owned(),
        domains: vec![ServiceDomain::Suffix("shared.example".to_owned())],
        version: "1".to_owned(),
        source: None,
        evidence: None,
    });
    overlapping.services.push(ServiceDefinition {
        id: "a-service".to_owned(),
        label: "A".to_owned(),
        domains: vec![ServiceDomain::Suffix("shared.example".to_owned())],
        version: "1".to_owned(),
        source: None,
        evidence: None,
    });

    let forward = compile(1, &[], Some(&overlapping), &both).unwrap();
    let reversed = compile(
        1,
        &[],
        Some(&overlapping),
        &["a-service".to_owned(), "z-service".to_owned()],
    )
    .unwrap();
    for snapshot in [&forward, &reversed] {
        match snapshot.evaluate(&name("shared.example."), RecordType::A) {
            FilterOutcome::Block { evidence } => {
                assert_eq!(
                    evidence.source_id, "a-service",
                    "lexicographically first id wins"
                );
            }
            other => panic!("overlap must block deterministically: {other:?}"),
        }
    }

    // An ABP exception is only a list-layer signal; selected service blocking
    // stays a block and never becomes an allow grant.
    let abp = ListSource {
        id: "abp".to_owned(),
        format: ListFormat::Abp,
        bytes: b"@@||video.example^\n||video.example^\n||allow.test^\n@@||allow.test^\n",
        source_url: None,
    };
    let with_exception = compile(1, &[abp], Some(&catalog()), &["video".to_owned()]).unwrap();
    assert!(matches!(
        with_exception.evaluate(&name("cdn.video.example."), RecordType::A),
        FilterOutcome::Block { .. }
    ));
    assert!(matches!(
        with_exception.evaluate(&name("allow.test."), RecordType::A),
        FilterOutcome::AllowException { .. }
    ));
}

#[test]
fn invalid_catalog_entries_fail_the_whole_candidate() {
    let selected = vec!["video".to_owned()];

    let unknown = vec!["absent".to_owned()];
    assert!(matches!(
        compile(1, &[], Some(&catalog()), &unknown),
        Err(CompileError::InvalidInput(_))
    ));

    let mut no_domains = catalog();
    no_domains.services[0].domains.clear();
    assert!(matches!(
        compile(1, &[], Some(&no_domains), &selected),
        Err(CompileError::InvalidInput(_))
    ));

    let mut wildcard = catalog();
    wildcard.services[0].domains[0] = ServiceDomain::Suffix("*.example".to_owned());
    assert!(matches!(
        compile(1, &[], Some(&wildcard), &selected),
        Err(CompileError::InvalidInput(_))
    ));

    let mut duplicate = catalog();
    duplicate.services[1].id = "video".to_owned();
    assert!(matches!(
        compile(1, &[], Some(&duplicate), &selected),
        Err(CompileError::InvalidInput(_))
    ));

    let limited = Limits {
        max_services: 1,
        ..Limits::default()
    };
    assert!(matches!(
        compile_with_limits(1, &[], Some(&catalog()), &selected, &limited),
        Err(CompileError::Limit(_))
    ));
}
