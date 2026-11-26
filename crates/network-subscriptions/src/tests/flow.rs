//! End-to-end tests against a real TLS loopback server. Certificates are
//! generated in-test and verified by reqwest; no verification is disabled.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::http::header::{ETAG, IF_NONE_MATCH, LAST_MODIFIED, RETRY_AFTER};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Response, StatusCode};
use axum::response::IntoResponse;
use axum::Router;

use crate::clock::{Clock, TestClock, TestRng};
use crate::config::{Limits, QueryPolicy, SourceMetadata, SubscriptionConfig, SubscriptionSource};
use crate::error::Error;
use crate::transport::ReqwestTransport;
use crate::{CompilationSummary, FetchOutcome, SubscriptionStatus, ValidationError};

const FIRST: &[u8] = b"domain=first.example\n";
const SECOND: &[u8] = b"domain=second.example\n";
const LAST_MODIFIED_VALUE: &str = "Wed, 21 Oct 2015 07:28:00 GMT";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum Mode {
    #[default]
    Ok,
    Bad,
    TooBig,
    Stall,
    RateLimited,
    AlwaysNew,
    Empty,
}

#[derive(Default)]
struct ServerState {
    body: Mutex<String>,
    etag: Mutex<String>,
    mode: Mutex<Mode>,
    hits: AtomicUsize,
    conditional_hits: AtomicUsize,
}

impl ServerState {
    fn set_content(&self, body: &[u8], etag: &str) {
        *self.body.lock().unwrap() = String::from_utf8(body.to_vec()).unwrap();
        *self.etag.lock().unwrap() = etag.to_owned();
    }
    fn set_mode(&self, mode: Mode) {
        *self.mode.lock().unwrap() = mode;
    }
}

fn header(resp: &mut Response<axum::body::Body>, name: HeaderName, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        resp.headers_mut().insert(name, value);
    }
}

async fn list_handler(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response<axum::body::Body> {
    state.hits.fetch_add(1, Ordering::SeqCst);
    let conditional = headers.get(IF_NONE_MATCH).and_then(|v| v.to_str().ok()).map(str::to_owned);
    if conditional.is_some() {
        state.conditional_hits.fetch_add(1, Ordering::SeqCst);
    }
    let mode = *state.mode.lock().unwrap();
    match mode {
        Mode::Ok => {
            let etag = state.etag.lock().unwrap().clone();
            if conditional.as_deref() == Some(etag.as_str()) {
                return StatusCode::NOT_MODIFIED.into_response();
            }
            let body = state.body.lock().unwrap().clone();
            let mut resp = (StatusCode::OK, body).into_response();
            header(&mut resp, ETAG, &etag);
            header(&mut resp, LAST_MODIFIED, LAST_MODIFIED_VALUE);
            resp
        }
        Mode::Bad => (StatusCode::OK, "this is not a list !!!").into_response(),
        Mode::Empty => (StatusCode::OK, "").into_response(),
        Mode::TooBig => (StatusCode::OK, "x".repeat(65)).into_response(),
        Mode::Stall => {
            tokio::time::sleep(Duration::from_secs(3)).await;
            (StatusCode::OK, "domain=late.example\n").into_response()
        }
        Mode::RateLimited => {
            let mut resp = (StatusCode::TOO_MANY_REQUESTS, "slow down").into_response();
            header(&mut resp, RETRY_AFTER, "3");
            resp
        }
        Mode::AlwaysNew => {
            // Each hit is a distinct revision, so two concurrent forced
            // refreshes cannot collapse into one write.
            let n = state.hits.load(Ordering::SeqCst);
            let body = format!("domain=new{n}.example\n");
            let etag = format!("\"new-{n}\"");
            let mut resp = (StatusCode::OK, body).into_response();
            header(&mut resp, ETAG, &etag);
            header(&mut resp, LAST_MODIFIED, LAST_MODIFIED_VALUE);
            resp
        }
    }
}

async fn spawn() -> (String, String, Arc<ServerState>) {
    let state = Arc::new(ServerState::default());
    state.set_content(FIRST, "\"v1\"");
    let router = Router::new().route("/list", axum::routing::get(list_handler)).with_state(state.clone());
    let (base, ca) = crate::test_support::spawn_tls_server(router).await;
    (base, ca, state)
}

fn config(base: &str, limits: Limits) -> SubscriptionConfig {
    SubscriptionConfig {
        sources: vec![SubscriptionSource {
            id: "public".into(),
            url: format!("{base}/list"),
            enabled: true,
            interval_secs: Some(300),
            max_stale_secs: Some(3600),
            metadata: SourceMetadata {
                title: "Public hosts".into(),
                publisher: "Operator".into(),
                license: "operator-approved".into(),
            },
        }],
        limits,
        query_policy: QueryPolicy::Reject,
    }
}

fn validator() -> impl crate::CandidateValidator {
    |bytes: &[u8]| -> Result<CompilationSummary, ValidationError> {
        let text = std::str::from_utf8(bytes).map_err(|_| ValidationError::new("not utf-8"))?;
        let mut count = 0u64;
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Some(value) = line.strip_prefix("domain=") else {
                return Err(ValidationError::new("malformed rule line"));
            };
            if !value.contains('.') {
                return Err(ValidationError::new("malformed rule line"));
            }
            count += 1;
        }
        if count == 0 {
            return Err(ValidationError::new("empty candidate"));
        }
        Ok(CompilationSummary { rule_count: count })
    }
}

fn fetcher(
    root: &std::path::Path,
    base: &str,
    ca: &str,
    cfg: &SubscriptionConfig,
    clock: Arc<TestClock>,
) -> crate::Fetcher<impl crate::CandidateValidator> {
    crate::test_support::fetcher_with_loopback(
        root,
        cfg,
        validator(),
        base,
        ca,
        clock,
        Arc::new(TestRng::new(vec![0; 64])),
    )
}

#[tokio::test]
async fn real_tls_conditional_get_last_good_and_restart_flow() {
    let (base, ca, state) = spawn().await;
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(TestClock::new(
        chrono::DateTime::from_timestamp_millis(1_700_000_000_000).unwrap(),
    ));
    let cfg = config(&base, Limits::default());
    let first_fetcher = fetcher(dir.path(), &base, &ca, &cfg, clock.clone());

    assert_eq!(first_fetcher.status("public").unwrap().status, SubscriptionStatus::NeverFetched);
    assert_eq!(first_fetcher.refresh("public", false).await.unwrap(), FetchOutcome::Fetched { revision: 1 });
    assert_eq!(first_fetcher.last_good_bytes("public").unwrap().unwrap(), FIRST);
    let report = first_fetcher.status("public").unwrap();
    assert_eq!(report.status, SubscriptionStatus::Fresh);
    assert_eq!(report.revision, 1);
    assert_eq!(report.rule_count, Some(1));
    assert!(report.content_updated_at.is_some(), "Last-Modified is content metadata");
    assert_eq!(state.hits.load(Ordering::SeqCst), 1);
    assert_eq!(state.conditional_hits.load(Ordering::SeqCst), 0);

    // Not due: no network I/O.
    assert_eq!(first_fetcher.refresh("public", false).await.unwrap(), FetchOutcome::Skipped);
    assert_eq!(state.hits.load(Ordering::SeqCst), 1);

    // 304 keeps content timestamps and bytes; only checked_at advances.
    clock.advance_ms(60_000);
    assert_eq!(first_fetcher.refresh("public", true).await.unwrap(), FetchOutcome::NotModified);
    assert_eq!(state.conditional_hits.load(Ordering::SeqCst), 1);
    let after_304 = first_fetcher.status("public").unwrap();
    assert_eq!(after_304.revision, 1);
    assert_eq!(after_304.fetched_at, report.fetched_at);
    assert_eq!(after_304.content_updated_at, report.content_updated_at);
    assert_eq!(after_304.checked_at, Some(clock.now()));
    assert_eq!(first_fetcher.last_good_bytes("public").unwrap().unwrap(), FIRST);

    // Changed content produces a new revision.
    state.set_content(SECOND, "\"v2\"");
    clock.advance_ms(60_000);
    assert_eq!(first_fetcher.refresh("public", true).await.unwrap(), FetchOutcome::Fetched { revision: 2 });
    assert_eq!(first_fetcher.last_good_bytes("public").unwrap().unwrap(), SECOND);
    let second_report = first_fetcher.status("public").unwrap();
    assert_eq!(second_report.revision, 2);
    assert_eq!(second_report.fetched_at, Some(clock.now()));
    assert_ne!(second_report.content_version, report.content_version);

    // Bad content never promotes; memory and disk keep the last good list.
    state.set_mode(Mode::Bad);
    clock.advance_ms(60_000);
    let err = first_fetcher.refresh("public", true).await.unwrap_err();
    assert!(matches!(err, Error::ValidationFailed(..)), "{err:?}");
    assert!(err.to_string().contains("malformed rule line"));
    let failed = first_fetcher.status("public").unwrap();
    assert_eq!(failed.status, SubscriptionStatus::FailedWithLastGood);
    assert_eq!(failed.failure_count, 1);
    assert_eq!(failed.consecutive_failures, 1);
    assert_eq!(first_fetcher.last_good_bytes("public").unwrap().unwrap(), SECOND);

    // An empty body is also rejected by the real compile callback.
    state.set_mode(Mode::Empty);
    clock.advance_ms(60_000);
    let err = first_fetcher.refresh("public", true).await.unwrap_err();
    assert!(matches!(err, Error::ValidationFailed(..)), "{err:?}");
    assert_eq!(first_fetcher.last_good_bytes("public").unwrap().unwrap(), SECOND);

    // 429 sets an abuse cooldown that even force respects.
    state.set_mode(Mode::RateLimited);
    clock.advance_ms(61_000);
    let err = first_fetcher.refresh("public", true).await.unwrap_err();
    assert!(matches!(err, Error::HttpStatus(429, _)), "{err:?}");
    let hits_after_429 = state.hits.load(Ordering::SeqCst);
    let err = first_fetcher.refresh("public", true).await.unwrap_err();
    assert!(matches!(err, Error::AbuseCooldown(..)), "{err:?}");
    assert_eq!(state.hits.load(Ordering::SeqCst), hits_after_429, "cooldown blocked the fetch");
    assert!(first_fetcher.status("public").unwrap().cooldown_until.is_some());

    clock.advance_ms(250_000);
    state.set_mode(Mode::Ok);
    state.set_content(b"domain=recovered.example\n", "\"v3\"");
    assert_eq!(first_fetcher.refresh("public", true).await.unwrap(), FetchOutcome::Fetched { revision: 3 });
    let healed = first_fetcher.status("public").unwrap();
    assert_eq!(healed.consecutive_failures, 0);
    assert!(healed.cooldown_until.is_none());

    // Offline restart loads validated bytes; no request is made.
    let saved = first_fetcher.last_good_bytes("public").unwrap().unwrap();
    let hits_before_restart = state.hits.load(Ordering::SeqCst);
    let saved_fetched_at = healed.fetched_at;
    drop(first_fetcher);
    let restarted = fetcher(dir.path(), &base, &ca, &cfg, clock.clone());
    assert_eq!(restarted.last_good_bytes("public").unwrap().unwrap(), saved);
    let reloaded = restarted.status("public").unwrap();
    assert_eq!(reloaded.revision, 3);
    assert_eq!(reloaded.fetched_at, saved_fetched_at, "restart never freshens content time");
    assert_ne!(reloaded.status, SubscriptionStatus::NeverFetched);
    assert_eq!(state.hits.load(Ordering::SeqCst), hits_before_restart);

    // Concurrent forced refreshes of the same id serialize without a lost
    // update: both responses are distinct 200s and both revisions survive.
    state.set_mode(Mode::AlwaysNew);
    let a = restarted.refresh("public", true);
    let b = restarted.refresh("public", true);
    let (a, b) = tokio::join!(a, b);
    assert!(a.is_ok() && b.is_ok(), "{a:?} {b:?}");
    assert!(restarted
        .last_good_bytes("public")
        .unwrap()
        .unwrap()
        .starts_with(b"domain=new"));
    assert_eq!(restarted.status("public").unwrap().revision, 5);

    // Disabling is immediate and non-blocking; no further fetch occurs.
    let hits_before_disable = state.hits.load(Ordering::SeqCst);
    restarted.set_enabled("public", false).unwrap();
    assert_eq!(restarted.status("public").unwrap().status, SubscriptionStatus::Disabled);
    assert!(matches!(restarted.refresh("public", true).await, Err(Error::Disabled(_))));
    assert_eq!(state.hits.load(Ordering::SeqCst), hits_before_disable);
}

#[tokio::test]
async fn bad_certificate_oversize_and_stall_preserve_last_good() {
    let (base, ca, state) = spawn().await;
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(TestClock::new(
        chrono::DateTime::from_timestamp_millis(1_700_000_000_000).unwrap(),
    ));
    let limits = Limits {
        max_candidate_bytes: 64,
        max_aggregate_bytes: 64,
        connect_timeout_secs: 1,
        request_timeout_secs: 1,
        ..Limits::default()
    };
    let cfg = config(&base, limits.clone());
    let fetcher = fetcher(dir.path(), &base, &ca, &cfg, clock.clone());
    assert!(fetcher.refresh("public", true).await.is_ok());

    // Oversized body is rejected before promotion.
    state.set_mode(Mode::TooBig);
    clock.advance_ms(60_000);
    let err = fetcher.refresh("public", true).await.unwrap_err();
    assert!(matches!(err, Error::LimitExceeded(..)), "{err:?}");
    assert_eq!(fetcher.last_good_bytes("public").unwrap().unwrap(), FIRST);
    assert_eq!(fetcher.status("public").unwrap().revision, 1);

    // A slow body times out even though the headers arrived quickly.
    state.set_mode(Mode::Stall);
    clock.advance_ms(120_000);
    let err = fetcher.refresh("public", true).await.unwrap_err();
    assert!(matches!(err, Error::Transport(..)), "{err:?}");
    assert_eq!(fetcher.last_good_bytes("public").unwrap().unwrap(), FIRST);

    // A well-formed but unrelated CA fails verification with TLS still on.
    let wrong_ca = crate::test_support::unrelated_ca_pem();
    let client = crate::test_support::loopback_client(&base, &wrong_ca, &limits);
    let transport = ReqwestTransport::from_client(
        client,
        limits.max_header_bytes,
        limits.request_timeout(),
    );
    let bad = crate::Fetcher::with_transport(
        dir.path().to_path_buf(),
        &cfg,
        validator(),
        Arc::new(transport),
    )
    .unwrap();
    clock.advance_ms(120_000);
    let err = bad.refresh("public", true).await.unwrap_err();
    assert!(matches!(err, Error::Transport(..)), "{err:?}");
    assert_eq!(bad.last_good_bytes("public").unwrap().unwrap(), FIRST, "same cache, unchanged");
}
