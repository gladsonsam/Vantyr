use std::io;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use chrono::{DateTime, Utc};

use crate::backoff::BackoffPolicy;
use crate::cache::{self, ListSnapshot, WriteHooks};
use crate::clock::{TestClock, TestRng};
use crate::config::{Limits, QueryPolicy};
use crate::error::Error;
use crate::scheduler::RefreshScheduler;
use crate::url::ValidatedUrl;

fn epoch() -> DateTime<Utc> {
    DateTime::from_timestamp_millis(1_700_000_000_000).unwrap()
}

fn url() -> ValidatedUrl {
    ValidatedUrl::parse(
        "https://example.com/lists/ads.txt",
        &QueryPolicy::Reject,
        512,
    )
    .unwrap()
}

fn snapshot(id: &str, revision: u64, body: &[u8]) -> ListSnapshot {
    ListSnapshot {
        schema: cache::SNAPSHOT_SCHEMA,
        source_id: id.into(),
        url: url().as_str().to_owned(),
        revision,
        validator_version: 1,
        bytes_b64: BASE64.encode(body),
        sha256: cache::sha256_hex(body),
        rule_count: 1,
        checked_at: epoch(),
        fetched_at: epoch(),
        content_updated_at: Some(epoch()),
        etag: Some("\"v1\"".into()),
        last_modified: Some("Wed, 21 Oct 2015 07:28:00 GMT".into()),
    }
}

#[test]
fn retry_after_is_bounded_and_dates_are_honest() {
    let policy = BackoffPolicy::default();
    assert_eq!(
        policy.parse_retry_after("3", epoch()),
        Some(Duration::from_secs(3))
    );
    assert_eq!(
        policy.parse_retry_after("999999999", epoch()),
        Some(Duration::from_secs(86_400))
    );
    assert!(policy.parse_retry_after("garbage", epoch()).is_none());
    assert_eq!(
        policy.parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT", epoch()),
        Some(Duration::ZERO)
    );
    let far = "Wed, 21 Oct 2099 07:28:00 GMT";
    assert_eq!(
        policy.parse_retry_after(far, epoch()),
        Some(Duration::from_secs(86_400))
    );
}

#[test]
fn backoff_is_deterministic_with_an_injected_rng() {
    let policy = BackoffPolicy::default();
    let zero = TestRng::new(vec![0, 0, 0]);
    assert_eq!(policy.delay(0, None, &zero), Duration::from_secs(60));
    assert_eq!(policy.delay(1, None, &zero), Duration::from_secs(120));
    assert_eq!(policy.delay(2, None, &zero), Duration::from_secs(240));
    let with_retry = TestRng::new(vec![0]);
    assert_eq!(
        policy.delay(0, Some(Duration::from_secs(3)), &with_retry),
        Duration::from_secs(60)
    );
    let capped = TestRng::new(vec![0]);
    assert_eq!(
        policy.delay(0, Some(Duration::from_secs(999_999)), &capped),
        Duration::from_secs(86_400)
    );
    let jitter = TestRng::new(vec![15_000]);
    assert_eq!(
        policy.delay(0, None, &jitter),
        Duration::from_millis(75_000)
    );
}

#[test]
fn scheduler_due_force_and_stale_use_the_injected_clock() {
    let clock = Arc::new(TestClock::new(epoch()));
    let scheduler = RefreshScheduler::new(
        clock.clone(),
        Arc::new(TestRng::default()),
        BackoffPolicy::default(),
    );
    assert!(scheduler.is_due(None, false));
    let due = scheduler.after_success(Duration::from_secs(24 * 3600));
    assert!(!scheduler.is_due(Some(due), false));
    assert!(scheduler.is_due(Some(due), true), "force ignores next_due");
    assert!(!scheduler.is_stale(Some(epoch()), Duration::from_secs(3600)));
    clock.advance_ms(2 * 3600 * 1000);
    assert!(scheduler.is_stale(Some(epoch()), Duration::from_secs(3600)));
    assert!(
        !scheduler.is_due(Some(due), false),
        "2 h is not the 24 h interval"
    );
    clock.advance_ms(23 * 3600 * 1000);
    assert!(scheduler.is_due(Some(due), false));
}

#[test]
fn cache_roundtrip_and_wrong_url_identity_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let limits = Limits::default();
    let original = snapshot("public", 3, b"domain=ads.example.com\n");
    cache::write_snapshot(dir.path(), &original, &limits, WriteHooks::default()).unwrap();
    let loaded = cache::read_snapshot(dir.path(), "public", &url(), &limits)
        .unwrap()
        .unwrap();
    assert_eq!(loaded, original);
    let other = ValidatedUrl::parse(
        "https://example.com/lists/other.txt",
        &QueryPolicy::Reject,
        512,
    )
    .unwrap();
    assert!(matches!(
        cache::read_snapshot(dir.path(), "public", &other, &limits),
        Err(Error::CacheUrlMismatch(_))
    ));
    assert!(cache::read_snapshot(dir.path(), "missing", &url(), &limits)
        .unwrap()
        .is_none());
}

#[test]
fn cache_rejects_malformed_oversize_and_symlinks_without_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let limits = Limits::default();
    let path = dir.path().join("public.json");
    std::fs::write(&path, b"{\"schema\":").unwrap();
    assert!(matches!(
        cache::read_snapshot(dir.path(), "public", &url(), &limits),
        Err(Error::CacheMalformed(..))
    ));
    std::fs::write(&path, b"x".repeat(limits.max_snapshot_bytes as usize + 1)).unwrap();
    assert!(matches!(
        cache::read_snapshot(dir.path(), "public", &url(), &limits),
        Err(Error::Cache(..))
    ));

    let small = Limits {
        max_snapshot_bytes: 8,
        ..Limits::default()
    };
    std::fs::write(&path, b"0123456789").unwrap();
    assert!(matches!(
        cache::read_snapshot(dir.path(), "public", &url(), &small),
        Err(Error::Cache(..))
    ));

    #[cfg(unix)]
    {
        let target = dir.path().join("real.json");
        std::fs::write(&target, b"{}").unwrap();
        let linked = dir.path().join("public.json");
        let _ = std::fs::remove_file(&linked);
        std::os::unix::fs::symlink(&target, &linked).unwrap();
        assert!(matches!(
            cache::read_snapshot(dir.path(), "public", &url(), &limits),
            Err(Error::UnsafeCachePath(_))
        ));
    }
}

fn fail_before(_path: &Path) -> io::Result<()> {
    Err(io::Error::other("injected before rename"))
}

fn fail_after(_path: &Path) -> io::Result<()> {
    Err(io::Error::other("injected after rename"))
}

#[test]
fn cache_write_is_atomic_owner_only_and_failure_keeps_old_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let limits = Limits::default();
    let first = snapshot("public", 1, b"domain=one.example\n");
    cache::write_snapshot(dir.path(), &first, &limits, WriteHooks::default()).unwrap();
    let path = dir.path().join("public.json");
    let committed = std::fs::read(&path).unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "cache may carry list contents");
    }

    let second = snapshot("public", 2, b"domain=two.example\n");
    let hooks = WriteHooks {
        before_rename: fail_before,
        after_rename: fail_after,
    };
    let err = cache::write_snapshot(dir.path(), &second, &limits, hooks).unwrap_err();
    assert!(err.to_string().contains("before rename"), "{err}");
    assert_eq!(
        std::fs::read(&path).unwrap(),
        committed,
        "old file retained"
    );

    // A post-rename sync failure is best effort and does not fail the write.
    let hooks = WriteHooks {
        before_rename: |_| Ok(()),
        after_rename: fail_after,
    };
    cache::write_snapshot(dir.path(), &second, &limits, hooks).unwrap();
    let loaded = cache::read_snapshot(dir.path(), "public", &url(), &limits)
        .unwrap()
        .unwrap();
    assert_eq!(loaded.revision, 2);
    assert_eq!(loaded.bytes().unwrap(), b"domain=two.example\n");
}

#[test]
fn restart_revalidates_cached_bytes_and_reports_raw_content_size() {
    use crate::config::{SourceMetadata, SubscriptionConfig, SubscriptionSource};
    use crate::{CompilationSummary, Fetcher, ValidationError};
    let dir = tempfile::tempdir().unwrap();
    let bytes = b"blocked.example\n";
    let cached = snapshot("public", 4, bytes);
    let limits = Limits::default();
    cache::write_snapshot(dir.path(), &cached, &limits, WriteHooks::default()).unwrap();
    let path = dir.path().join("public.json");
    // Cache path is private to the cache module; locate the one published file.
    let path = if path.exists() {
        path
    } else {
        std::fs::read_dir(dir.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path()
    };
    let original = std::fs::read(&path).unwrap();
    let config = SubscriptionConfig {
        sources: vec![SubscriptionSource {
            id: "public".into(),
            url: url().as_str().into(),
            enabled: true,
            interval_secs: None,
            max_stale_secs: None,
            metadata: SourceMetadata {
                title: "test".into(),
                publisher: "operator".into(),
                license: "MIT".into(),
            },
        }],
        ..Default::default()
    };
    let reject = |_: &[u8]| {
        Err::<CompilationSummary, _>(ValidationError {
            detail: "new compiler rejects old syntax".into(),
        })
    };
    assert!(matches!(
        Fetcher::new(dir.path(), &config, reject),
        Err(Error::ValidationFailed(_, _))
    ));
    assert_eq!(std::fs::read(&path).unwrap(), original);
    let accept = |body: &[u8]| {
        assert_eq!(body, bytes);
        Ok::<_, ValidationError>(CompilationSummary { rule_count: 7 })
    };
    let fetcher = Fetcher::new(dir.path(), &config, accept)
        .unwrap()
        .with_validator_version(2);
    let report = fetcher.status("public").unwrap();
    assert_eq!(report.bytes, bytes.len());
    assert_eq!(report.rule_count, Some(7));
    assert_eq!(report.validator_version, 2);
    assert_eq!(report.cached_validator_version, Some(1));
    assert_eq!(report.fetched_at, Some(epoch()));
    assert_eq!(report.revision, 4);
    assert_eq!(std::fs::read(path).unwrap(), original);
}
