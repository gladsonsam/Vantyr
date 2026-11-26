//! Real loopback HTTP/CONNECT tests for opt-in centrally issued credentials and
//! verified session evidence. No DNS, router, CA or host state is touched; every
//! listener is an ephemeral loopback socket.

mod support;

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use family_policy::{
    evaluate, Action, Assignment, AssignmentRole, DecisionSource, Effect, EvaluationContext, Rule,
    RuleMatcher,
};
use family_proxy::auth::AuthState;
use family_proxy::credentials::{
    CredentialStore, HouseholdKind, VerifiedCredential, COMMAND_PROXY_CONNECT, COMMAND_PROXY_HTTP,
};
use family_proxy::session_evidence::{
    EvidenceFailure, LocalEvidenceVerifier, SessionEvidence, SessionEvidenceVerifier,
    SESSION_EVIDENCE_AUDIENCE, SESSION_EVIDENCE_HEADER,
};
use family_proxy::{Config, ProxyServer};
use rama::http::headers::{HeaderEncode, HeaderMapExt, ProxyAuthorization};
use rama::http::Request;
use rama::net::user::Basic;
use support::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Barrier;
use uuid::Uuid;

const HOUSEHOLD: &str = "11111111-2222-3333-4444-555555555555";
const DEVICE: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PERSON: &str = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const GENERATION: u64 = 7;

/// The live listener authenticates with wall-clock time, so test issuance must
/// use the same clock rather than a frozen instant.
fn now() -> DateTime<Utc> {
    Utc::now()
}

fn household() -> Uuid {
    Uuid::parse_str(HOUSEHOLD).unwrap()
}
fn device() -> Uuid {
    Uuid::parse_str(DEVICE).unwrap()
}
fn person() -> Uuid {
    Uuid::parse_str(PERSON).unwrap()
}

fn auth_header(id: Uuid, secret: &str) -> String {
    let basic = Basic::try_from(format!("{id}:{secret}").as_str()).unwrap();
    let mut values: Vec<rama::http::HeaderValue> = Vec::new();
    HeaderEncode::encode(&ProxyAuthorization(basic), &mut values);
    values[0].to_str().unwrap().to_owned()
}

fn evidence(command: &str, nonce: &str) -> SessionEvidence {
    SessionEvidence {
        schema: family_proxy::session_evidence::EVIDENCE_SCHEMA,
        session_id: Uuid::new_v4(),
        household_id: household(),
        device_id: device(),
        verified_person: Some(person()),
        binding_generation: GENERATION,
        household_kind: HouseholdKind::Personal,
        audience: SESSION_EVIDENCE_AUDIENCE.to_owned(),
        command: command.to_owned(),
        issued_at: now(),
        expires_at: now() + Duration::from_secs(600),
        nonce: nonce.to_owned(),
    }
}

fn evidence_text(verifier: &LocalEvidenceVerifier, ev: &SessionEvidence) -> String {
    let bytes = verifier.issue(ev).unwrap();
    String::from_utf8(bytes).unwrap()
}

fn assignment() -> Assignment {
    Assignment {
        id: Uuid::new_v4(),
        person_id: person(),
        device_id: device(),
        role: AssignmentRole::Member,
        active: true,
    }
}

fn session_config(origin: std::net::SocketAddr, echo: std::net::SocketAddr) -> Config {
    let mut config = test_config(origin, echo);
    // The credential under test is bound to a personal device, so a verified
    // person is admissible. Shared devices are covered in the library tests.
    config.devices[0].shared = false;
    config
}

fn http_get(auth: &str, evidence: Option<&str>, authority: &str, path: &str) -> String {
    let evidence = evidence
        .map(|value| format!("{SESSION_EVIDENCE_HEADER}: {value}\r\n"))
        .unwrap_or_default();
    format!(
        "GET http://{authority}{path} HTTP/1.1\r\nHost: {authority}\r\nProxy-Authorization: {auth}\r\n{evidence}Connection: close\r\n\r\n"
    )
}

fn connect_req(auth: &str, evidence: Option<&str>, host: &str, port: u16) -> String {
    let evidence = evidence
        .map(|value| format!("{SESSION_EVIDENCE_HEADER}: {value}\r\n"))
        .unwrap_or_default();
    format!(
        "CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nProxy-Authorization: {auth}\r\n{evidence}\r\n"
    )
}

fn issue(store: &CredentialStore) -> (Uuid, family_proxy::Secret) {
    store
        .issue(
            household(),
            device(),
            GENERATION,
            HouseholdKind::Personal,
            &[COMMAND_PROXY_CONNECT, COMMAND_PROXY_HTTP],
            3600,
            now(),
        )
        .unwrap()
}

#[tokio::test]
async fn credential_and_scoped_evidence_allow_http_without_leaking_either_to_origin() {
    let origin = HttpOrigin::start().await;
    let echo = EchoOrigin::start().await;
    let store = CredentialStore::new();
    let (id, secret) = issue(&store);
    let verifier = LocalEvidenceVerifier::new();
    let ev = evidence(COMMAND_PROXY_HTTP, "http-nonce-1");
    let raw = evidence_text(&verifier, &ev);
    let proxy = ProxyServer::start_with_session_auth(
        session_config(origin.addr, echo.addr),
        NoDnsResolver,
        Arc::new(store),
        Arc::new(verifier),
        vec![assignment()],
    )
    .await
    .unwrap();

    let mut client = connect(proxy.bind_addr()).await;
    send(
        &mut client,
        &http_get(
            &auth_header(id, secret.expose()),
            Some(&raw),
            &format!("origin.test:{}", origin.addr.port()),
            "/allowed?q=1",
        ),
    )
    .await;
    let head = read_head(&mut client).await;
    assert_eq!(status_line(&head), 200, "response was: {head:?}");
    assert_eq!(origin.connections(), 1, "exactly one origin dial");
    let seen = origin.seen.lock().unwrap().clone();
    let request = &seen[0];
    assert!(
        !request.to_ascii_lowercase().contains("proxy-authorization"),
        "the proxy credential must not reach the origin"
    );
    assert!(
        !request
            .to_ascii_lowercase()
            .contains("x-vantyr-session-evidence"),
        "session evidence is worker-internal and must not reach the origin"
    );
    proxy.stop().await;
}

#[tokio::test]
async fn revoked_credential_is_denied_before_any_egress() {
    let origin = HttpOrigin::start().await;
    let echo = EchoOrigin::start().await;
    let store = CredentialStore::new();
    let (id, secret) = issue(&store);
    let verifier = LocalEvidenceVerifier::new();
    let raw = evidence_text(&verifier, &evidence(COMMAND_PROXY_HTTP, "http-nonce-2"));
    assert!(store.revoke(id, now()));

    let proxy = ProxyServer::start_with_session_auth(
        session_config(origin.addr, echo.addr),
        NoDnsResolver,
        Arc::new(store),
        Arc::new(verifier),
        vec![assignment()],
    )
    .await
    .unwrap();
    let mut client = connect(proxy.bind_addr()).await;
    send(
        &mut client,
        &http_get(
            &auth_header(id, secret.expose()),
            Some(&raw),
            &format!("origin.test:{}", origin.addr.port()),
            "/",
        ),
    )
    .await;
    let head = read_head(&mut client).await;
    assert_eq!(status_line(&head), 407, "revoked credential: {head:?}");
    assert_eq!(
        origin.connections(),
        0,
        "no origin contact after revocation"
    );
    proxy.stop().await;
}

#[tokio::test]
async fn revoked_and_replayed_evidence_deny_before_any_egress() {
    let origin = HttpOrigin::start().await;
    let echo = EchoOrigin::start().await;
    let store = CredentialStore::new();
    let (id, secret) = issue(&store);
    let verifier = LocalEvidenceVerifier::new();
    let revoked_ev = evidence(COMMAND_PROXY_HTTP, "http-nonce-3");
    let revoked_raw = evidence_text(&verifier, &revoked_ev);
    assert!(verifier.revoke(revoked_ev.session_id, now()));

    let proxy = ProxyServer::start_with_session_auth(
        session_config(origin.addr, echo.addr),
        NoDnsResolver,
        Arc::new(store.clone()),
        Arc::new(verifier.clone()),
        vec![assignment()],
    )
    .await
    .unwrap();
    let auth = auth_header(id, secret.expose());
    let target = format!("origin.test:{}", origin.addr.port());

    let mut client = connect(proxy.bind_addr()).await;
    send(
        &mut client,
        &http_get(&auth, Some(&revoked_raw), &target, "/"),
    )
    .await;
    assert_eq!(status_line(&read_head(&mut client).await), 403);
    assert_eq!(
        origin.connections(),
        0,
        "revoked evidence must not reach origin"
    );

    let live_ev = evidence(COMMAND_PROXY_HTTP, "http-nonce-4");
    let live_raw = evidence_text(&verifier, &live_ev);
    let mut client = connect(proxy.bind_addr()).await;
    send(&mut client, &http_get(&auth, Some(&live_raw), &target, "/")).await;
    assert_eq!(status_line(&read_head(&mut client).await), 200);
    assert_eq!(origin.connections(), 1);

    let mut client = connect(proxy.bind_addr()).await;
    send(&mut client, &http_get(&auth, Some(&live_raw), &target, "/")).await;
    let head = read_head(&mut client).await;
    assert_eq!(status_line(&head), 403, "replayed evidence: {head:?}");
    assert!(head.contains("evidence_replay"));
    assert_eq!(
        origin.connections(),
        1,
        "replay must not create a second dial"
    );
    proxy.stop().await;
}

#[tokio::test]
async fn connect_tunnel_requires_matching_command_and_live_credential() {
    let origin = HttpOrigin::start().await;
    let echo = EchoOrigin::start().await;
    let store = CredentialStore::new();
    let (id, secret) = issue(&store);
    let verifier = LocalEvidenceVerifier::new();
    let raw = evidence_text(
        &verifier,
        &evidence(COMMAND_PROXY_CONNECT, "connect-nonce-1"),
    );
    let proxy = ProxyServer::start_with_session_auth(
        session_config(origin.addr, echo.addr),
        NoDnsResolver,
        Arc::new(store.clone()),
        Arc::new(verifier),
        vec![assignment()],
    )
    .await
    .unwrap();
    let auth = auth_header(id, secret.expose());

    let mut client = connect(proxy.bind_addr()).await;
    send(
        &mut client,
        &connect_req(&auth, Some(&raw), "echo.test", echo.addr.port()),
    )
    .await;
    assert_eq!(status_line(&read_head(&mut client).await), 200);
    assert_eq!(echo.connections(), 1, "egress before CONNECT ack");
    client.write_all(b"session-auth").await.unwrap();
    let mut reply = [0u8; 12];
    tokio::time::timeout(Duration::from_secs(3), client.read_exact(&mut reply))
        .await
        .expect("tunnel read timeout")
        .expect("tunnel read failed");
    assert_eq!(&reply, b"session-auth");

    // Revocation stops new tunnels but does not retroactively close the live
    // one; that limitation is documented in the contract handoff.
    assert!(store.revoke(id, now()));
    let mut client = connect(proxy.bind_addr()).await;
    send(
        &mut client,
        &connect_req(&auth, Some(&raw), "echo.test", echo.addr.port()),
    )
    .await;
    let head = read_head(&mut client).await;
    assert_eq!(status_line(&head), 407, "revoked CONNECT: {head:?}");
    assert_eq!(echo.connections(), 1, "no new tunnel after revocation");
    proxy.stop().await;
}

#[tokio::test]
async fn wrong_command_evidence_cannot_widen_a_connect() {
    let origin = HttpOrigin::start().await;
    let echo = EchoOrigin::start().await;
    let store = CredentialStore::new();
    let (id, secret) = issue(&store);
    let verifier = LocalEvidenceVerifier::new();
    let raw = evidence_text(&verifier, &evidence(COMMAND_PROXY_HTTP, "connect-nonce-2"));
    let proxy = ProxyServer::start_with_session_auth(
        session_config(origin.addr, echo.addr),
        NoDnsResolver,
        Arc::new(store),
        Arc::new(verifier),
        vec![assignment()],
    )
    .await
    .unwrap();
    let mut client = connect(proxy.bind_addr()).await;
    send(
        &mut client,
        &connect_req(
            &auth_header(id, secret.expose()),
            Some(&raw),
            "echo.test",
            echo.addr.port(),
        ),
    )
    .await;
    let head = read_head(&mut client).await;
    assert_eq!(status_line(&head), 403);
    assert!(head.contains("evidence_command_mismatch"));
    assert_eq!(echo.connections(), 0, "no tunnel for out-of-scope evidence");
    proxy.stop().await;
}

#[tokio::test]
async fn verified_person_rules_require_correctly_scoped_evidence() {
    let origin = HttpOrigin::start().await;
    let echo = EchoOrigin::start().await;
    let config = session_config(origin.addr, echo.addr);
    let store = CredentialStore::new();
    let (id, secret) = issue(&store);
    let verifier = LocalEvidenceVerifier::new();
    let raw = evidence_text(&verifier, &evidence(COMMAND_PROXY_HTTP, "person-nonce-1"));
    let auth = AuthState::with_session_auth(
        &config,
        Default::default(),
        Arc::new(store),
        Arc::new(verifier),
        vec![assignment()],
    );

    let mut request = Request::builder()
        .method("GET")
        .uri("http://blocked.test/")
        .body(())
        .unwrap();
    request.headers_mut().typed_insert(ProxyAuthorization(
        Basic::try_from(format!("{id}:{}", secret.expose()).as_str()).unwrap(),
    ));
    request.headers_mut().insert(
        rama::http::HeaderName::from_static(SESSION_EVIDENCE_HEADER),
        rama::http::HeaderValue::from_str(&raw).unwrap(),
    );

    let with = auth
        .authenticate_with_session(&request, Some(&raw), COMMAND_PROXY_HTTP, now())
        .unwrap();
    let verified: VerifiedCredential = with.credential.clone().unwrap();
    assert_eq!(verified.device_id, device());
    assert!(with.verified.is_some(), "verified identity must be present");

    let without = auth
        .authenticate_with_session(&request, None, COMMAND_PROXY_HTTP, now())
        .unwrap();
    assert!(
        without.verified.is_none(),
        "a binding alone is not a person"
    );

    let mut policy = config.policy(now());
    policy.person_rules.insert(
        person(),
        vec![Rule {
            id: "parent-allow-blocked".into(),
            effect: Effect::Allow,
            matcher: RuleMatcher::DomainSuffix("blocked.test".into()),
            schedule: None,
            reason: "verified parent".into(),
        }],
    );
    let device_record = config.device_for(&config.clients[0]);
    let action = Action::HttpRequest {
        host: "blocked.test".into(),
        path: "/".into(),
    };
    let decide = |client: &family_proxy::AuthenticatedClient| {
        evaluate(
            &policy,
            &EvaluationContext {
                now: now(),
                device: &device_record,
                session: client.verified.as_ref().map(|v| &v.session),
                assignments: client
                    .verified
                    .as_ref()
                    .map(|v| v.assignments.as_slice())
                    .unwrap_or(&[]),
                connections: &[],
                action: action.clone(),
                heartbeat_ttl_secs: 90,
            },
        )
    };
    assert_eq!(decide(&with).source, DecisionSource::VerifiedPerson);
    assert!(decide(&with).allow);
    assert_eq!(decide(&without).source, DecisionSource::DeviceDefault);
    assert!(!decide(&without).allow);
}

#[tokio::test]
async fn concurrent_replay_yields_exactly_one_success() {
    let verifier = Arc::new(LocalEvidenceVerifier::new());
    let mut ev = evidence(COMMAND_PROXY_HTTP, "race-nonce-1");
    ev.verified_person = None; // no assignment needed; this test isolates replay
    let raw = Arc::new(evidence_text(&verifier, &ev));
    let barrier = Arc::new(Barrier::new(9));
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let verifier = verifier.clone();
        let raw = raw.clone();
        let barrier = barrier.clone();
        tasks.push(tokio::spawn(async move {
            let expectation = family_proxy::EvidenceExpectation {
                household_id: household(),
                device_id: device(),
                generation: GENERATION,
                household_kind: HouseholdKind::Personal,
                command: COMMAND_PROXY_HTTP,
                assignments: &[],
            };
            barrier.wait().await;
            verifier.verify(raw.as_bytes(), now(), &expectation)
        }));
    }
    barrier.wait().await;
    let mut accepted = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok(_) => accepted += 1,
            Err(EvidenceFailure::Replay) => {}
            Err(other) => panic!("unexpected evidence failure: {other:?}"),
        }
    }
    assert_eq!(accepted, 1, "exactly one concurrent use may succeed");
}

#[tokio::test]
async fn revocation_is_visible_to_every_subsequent_verification() {
    let store = Arc::new(CredentialStore::new());
    let (id, secret) = issue(&store);
    let devices = [device()].into_iter().collect();
    let scope = family_proxy::CredentialScope {
        household_id: household(),
        allowed_devices: &devices,
        command: COMMAND_PROXY_HTTP,
    };
    let presented = family_proxy::PresentedCredential::from_basic(
        &Basic::try_from(format!("{id}:{}", secret.expose()).as_str()).unwrap(),
    )
    .unwrap();
    assert!(store.verify(&presented, &scope, now()).is_ok());
    store.revoke(id, now());
    for _ in 0..16 {
        assert_eq!(
            store.verify(&presented, &scope, now()).err(),
            Some(family_proxy::CredentialFailure::Revoked)
        );
    }
}

#[tokio::test]
async fn present_evidence_is_single_use_even_for_a_policy_denied_request() {
    // Deliberate fail-closed semantics: consumption happens at authentication
    // (after all scope checks) and before target/policy/body evaluation. A
    // request denied later still consumes the one-time receipt; there is no
    // post-denial "give it back" path that could introduce a TOCTOU window.
    let origin = HttpOrigin::start().await;
    let echo = EchoOrigin::start().await;
    let store = CredentialStore::new();
    let (id, secret) = issue(&store);
    let verifier = LocalEvidenceVerifier::new();
    let mut ev = evidence(COMMAND_PROXY_HTTP, "denied-nonce-1");
    ev.verified_person = None;
    let raw = evidence_text(&verifier, &ev);
    let proxy = ProxyServer::start_with_session_auth(
        session_config(origin.addr, echo.addr),
        NoDnsResolver,
        Arc::new(store),
        Arc::new(verifier.clone()),
        vec![],
    )
    .await
    .unwrap();

    let mut client = connect(proxy.bind_addr()).await;
    send(
        &mut client,
        &http_get(
            &auth_header(id, secret.expose()),
            Some(&raw),
            &format!("blocked.test:{}", origin.addr.port()),
            "/",
        ),
    )
    .await;
    assert_eq!(status_line(&read_head(&mut client).await), 403);
    assert_eq!(origin.connections(), 0, "policy denial precedes egress");

    let expectation = family_proxy::EvidenceExpectation {
        household_id: household(),
        device_id: device(),
        generation: GENERATION,
        household_kind: HouseholdKind::Personal,
        command: COMMAND_PROXY_HTTP,
        assignments: &[],
    };
    assert_eq!(
        verifier.verify(raw.as_bytes(), now(), &expectation),
        Err(EvidenceFailure::Replay),
        "a denied request must not return the one-time receipt to the caller"
    );
    proxy.stop().await;
}

#[tokio::test]
async fn default_worker_never_accepts_a_centrally_issued_credential() {
    let origin = HttpOrigin::start().await;
    let echo = EchoOrigin::start().await;
    let store = CredentialStore::new();
    let (id, secret) = issue(&store);
    let proxy = start_proxy(session_config(origin.addr, echo.addr)).await;

    let mut client = connect(proxy.bind_addr()).await;
    send(
        &mut client,
        &http_get(
            &auth_header(id, secret.expose()),
            None,
            &format!("origin.test:{}", origin.addr.port()),
            "/",
        ),
    )
    .await;
    assert_eq!(status_line(&read_head(&mut client).await), 407);
    assert_eq!(origin.connections(), 0);
    proxy.stop().await;
}
