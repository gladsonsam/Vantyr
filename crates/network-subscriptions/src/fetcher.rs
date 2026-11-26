//! Subscription fetcher. Every failure path preserves the last-known-good
//! snapshot; only a successful HTTP 200 that also passes the caller's compile
//! callback can create a new revision.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use chrono::{DateTime, Utc};

use crate::backoff::BackoffPolicy;
use crate::cache::{self, ListSnapshot, WriteHooks};
use crate::clock::{SharedClock, SharedRng};
use crate::config::{Limits, SubscriptionConfig, ValidatedSource};
use crate::error::Error;
use crate::scheduler::RefreshScheduler;
use crate::status::{SubscriptionReport, SubscriptionStatus};
use crate::transport::{ConditionalHeaders, HttpTransport, ReqwestTransport};
use crate::url::ValidatedUrl;
use crate::validate::CandidateValidator;

#[derive(Clone, Debug)]
pub struct ListState {
    pub source: ValidatedSource,
    pub snapshot: Option<ListSnapshot>,
    pub checked_at: Option<DateTime<Utc>>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub failure_count: u64,
    pub consecutive_failures: u32,
    pub last_error: Option<String>,
    pub next_due_at: Option<DateTime<Utc>>,
    /// Abuse cooldown from 429/503. A forced refresh ignores `next_due_at`
    /// but never this.
    pub cooldown_until: Option<DateTime<Utc>>,
    pub backoff_attempt: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FetchOutcome {
    Fetched {
        revision: u64,
    },
    NotModified,
    /// Not due yet; no network I/O happened.
    Skipped,
}

struct BuildOptions {
    hooks: WriteHooks,
    clock: Option<SharedClock>,
    rng: Option<SharedRng>,
}

pub struct Fetcher<V> {
    root: PathBuf,
    limits: Limits,
    validator: V,
    validator_version: u32,
    transport: Arc<dyn HttpTransport>,
    scheduler: RefreshScheduler,
    states: Mutex<HashMap<String, ListState>>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    hooks: WriteHooks,
    // Serialize aggregate-cap check through disk/memory promotion across sources.
    promotion: Mutex<()>,
}

impl<V: CandidateValidator> Fetcher<V> {
    /// Production constructor: builds a reqwest client with the vetted
    /// resolver, redirects disabled and the maintained rustls stack.
    pub fn new(
        root: impl Into<PathBuf>,
        config: &SubscriptionConfig,
        validator: V,
    ) -> Result<Self, Error> {
        let (limits, _sources) = config.validate()?;
        let transport = Arc::new(ReqwestTransport::new(&limits, None, None)?);
        Self::with_transport(root, config, validator, transport)
    }

    /// Dependency-injection seam for tests/embedding. The transport is already
    /// configured by the caller; this crate still enforces every byte/size and
    /// promotion rule itself.
    pub fn with_transport(
        root: impl Into<PathBuf>,
        config: &SubscriptionConfig,
        validator: V,
        transport: Arc<dyn HttpTransport>,
    ) -> Result<Self, Error> {
        let (limits, sources) = config.validate()?;
        let policy = BackoffPolicy::from_limits(
            Duration::from_secs(limits.max_backoff_secs),
            Duration::from_secs(limits.max_retry_after_secs),
        );
        Self::assemble(
            root,
            limits,
            sources,
            validator,
            transport,
            policy,
            BuildOptions {
                hooks: WriteHooks::default(),
                clock: None,
                rng: None,
            },
        )
    }

    fn assemble(
        root: impl Into<PathBuf>,
        limits: Limits,
        sources: Vec<ValidatedSource>,
        validator: V,
        transport: Arc<dyn HttpTransport>,
        policy: BackoffPolicy,
        options: BuildOptions,
    ) -> Result<Self, Error> {
        let root = root.into();
        let mut states = HashMap::new();
        let mut locks = HashMap::new();
        let mut aggregate = 0u64;
        for source in sources {
            let mut snapshot = cache::read_snapshot(&root, &source.id, &source.url, &limits)?;
            if let Some(cached) = snapshot.as_mut() {
                // A digest authenticates neither syntax nor compiler compatibility.
                // Always apply the CURRENT callback before exposing cached bytes.
                let bytes = cached.bytes()?;
                let summary = validator.validate(&bytes).map_err(|err| {
                    Error::ValidationFailed(
                        source.id.clone(),
                        Error::bounded_detail(&err.detail, limits.max_diagnostic_bytes),
                    )
                })?;
                cached.rule_count = summary.rule_count;
                aggregate += bytes.len() as u64;
                if aggregate > limits.max_aggregate_bytes {
                    return Err(Error::LimitExceeded(
                        source.id.clone(),
                        "aggregate bytes",
                        limits.max_aggregate_bytes,
                    ));
                }
            }
            let checked_at = snapshot.as_ref().map(|s| s.checked_at);
            let last_success_at = snapshot.as_ref().map(|s| s.fetched_at);
            states.insert(
                source.id.clone(),
                ListState {
                    source,
                    snapshot,
                    checked_at,
                    last_success_at,
                    failure_count: 0,
                    consecutive_failures: 0,
                    last_error: None,
                    next_due_at: None,
                    cooldown_until: None,
                    backoff_attempt: 0,
                },
            );
        }
        for id in states.keys() {
            locks.insert(id.clone(), Arc::new(tokio::sync::Mutex::new(())));
        }
        let scheduler = match (options.clock, options.rng) {
            (Some(c), Some(r)) => RefreshScheduler::new(c, r, policy),
            _ => RefreshScheduler::default(),
        };
        Ok(Self {
            root,
            limits,
            validator,
            validator_version: 1,
            transport,
            scheduler,
            states: Mutex::new(states),
            locks: Mutex::new(locks),
            hooks: options.hooks,
            promotion: Mutex::new(()),
        })
    }

    pub fn with_validator_version(mut self, version: u32) -> Self {
        self.validator_version = version;
        self
    }

    pub fn with_hooks(mut self, hooks: WriteHooks) -> Self {
        self.hooks = hooks;
        self
    }

    /// Inject deterministic clock/RNG for scheduling and backoff tests. This
    /// does not relax any SSRF, TLS or promotion rule.
    pub fn with_timing(mut self, clock: SharedClock, rng: SharedRng) -> Self {
        let policy = BackoffPolicy::from_limits(
            Duration::from_secs(self.limits.max_backoff_secs),
            Duration::from_secs(self.limits.max_retry_after_secs),
        );
        self.scheduler = RefreshScheduler::new(clock, rng, policy);
        self
    }

    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    /// Refresh one source. Concurrent calls for the same id serialize on a
    /// per-id mutex, so no future write can lose another update.
    pub async fn refresh(&self, id: &str, force: bool) -> Result<FetchOutcome, Error> {
        let lock = {
            self.locks
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or_else(|| Error::UnknownSource(id.to_owned()))?
        };
        let _guard = lock.lock().await;
        let state = {
            self.states
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or_else(|| Error::UnknownSource(id.to_owned()))?
        };
        if !state.source.enabled {
            return Err(Error::Disabled(id.to_owned()));
        }
        let now = self.scheduler.now();
        if let Some(until) = state.cooldown_until {
            if now < until {
                return Err(Error::AbuseCooldown(id.to_owned(), until.to_rfc3339()));
            }
        }
        if !self.scheduler.is_due(state.next_due_at, force) {
            return Ok(FetchOutcome::Skipped);
        }

        let conditional = state
            .snapshot
            .as_ref()
            .map(|s| ConditionalHeaders {
                if_none_match: s.etag.clone(),
                if_modified_since: s.last_modified.clone(),
            })
            .unwrap_or_default();

        let response = match self
            .transport
            .get(
                &state.source.url,
                conditional,
                self.limits.max_candidate_bytes,
            )
            .await
        {
            Ok(response) => response,
            Err(err) => {
                self.record_failure(id, &err.to_string(), None);
                return Err(err);
            }
        };

        match response.status {
            304 => self.handle_not_modified(id, state, now),
            200 => self.handle_content(id, state, response, now),
            429 | 503 => {
                let retry = response
                    .retry_after
                    .as_deref()
                    .and_then(|value| self.scheduler.policy().parse_retry_after(value, now));
                let err = Error::HttpStatus(response.status, id.to_owned());
                self.record_failure(id, &err.to_string(), retry);
                Err(err)
            }
            status if (300..400).contains(&status) => {
                let err = Error::RedirectUnsupported(id.to_owned(), status);
                self.record_failure(id, &err.to_string(), None);
                Err(err)
            }
            status => {
                let err = Error::HttpStatus(status, id.to_owned());
                self.record_failure(id, &err.to_string(), None);
                Err(err)
            }
        }
    }

    fn handle_not_modified(
        &self,
        id: &str,
        mut state: ListState,
        now: DateTime<Utc>,
    ) -> Result<FetchOutcome, Error> {
        let Some(mut snapshot) = state.snapshot.clone() else {
            let err = Error::Cache(id.to_owned(), "304 without a cached list".into());
            self.record_failure(id, &err.to_string(), None);
            return Err(err);
        };
        if !self.is_enabled(id) {
            return Err(Error::Disabled(id.to_owned()));
        }
        // Only checked_at moves. Content timestamps, bytes and digest stay.
        snapshot.checked_at = now;
        if let Err(err) = cache::write_snapshot(&self.root, &snapshot, &self.limits, self.hooks) {
            self.record_failure(id, &err.to_string(), None);
            return Err(err);
        }
        state.snapshot = Some(snapshot);
        state.checked_at = Some(now);
        state.last_success_at = Some(now);
        state.consecutive_failures = 0;
        state.cooldown_until = None;
        state.backoff_attempt = 0;
        state.next_due_at = Some(self.scheduler.after_success(state.source.interval));
        self.states.lock().unwrap().insert(id.to_owned(), state);
        Ok(FetchOutcome::NotModified)
    }

    fn handle_content(
        &self,
        id: &str,
        mut state: ListState,
        response: crate::transport::TransportResponse,
        now: DateTime<Utc>,
    ) -> Result<FetchOutcome, Error> {
        if !self.is_enabled(id) {
            return Err(Error::Disabled(id.to_owned()));
        }
        let _promotion = self.promotion.lock().unwrap();
        let bytes = response.body;
        if bytes.len() as u64 > self.limits.max_candidate_bytes {
            let err = Error::LimitExceeded(
                id.to_owned(),
                "candidate bytes",
                self.limits.max_candidate_bytes,
            );
            self.record_failure(id, &err.to_string(), None);
            return Err(err);
        }
        let aggregate = self.aggregate_bytes_except(id) + bytes.len() as u64;
        if aggregate > self.limits.max_aggregate_bytes {
            let err = Error::LimitExceeded(
                id.to_owned(),
                "aggregate bytes",
                self.limits.max_aggregate_bytes,
            );
            self.record_failure(id, &err.to_string(), None);
            return Err(err);
        }
        // Preflight finished; now spend the compile callback.
        let summary = match self.validator.validate(&bytes) {
            Ok(summary) => summary,
            Err(err) => {
                let detail = Error::bounded_detail(&err.detail, self.limits.max_diagnostic_bytes);
                let failure = Error::ValidationFailed(id.to_owned(), detail);
                self.record_failure(id, &failure.to_string(), None);
                return Err(failure);
            }
        };
        let revision = state
            .snapshot
            .as_ref()
            .map_or(1, |s| s.revision.saturating_add(1));
        let digest = cache::sha256_hex(&bytes);
        let content_updated_at = response.last_modified.as_deref().and_then(parse_http_date);
        let snapshot = ListSnapshot {
            schema: cache::SNAPSHOT_SCHEMA,
            source_id: id.to_owned(),
            url: state.source.url.as_str().to_owned(),
            revision,
            validator_version: self.validator_version,
            bytes_b64: BASE64.encode(&bytes),
            sha256: digest.clone(),
            rule_count: summary.rule_count,
            checked_at: now,
            fetched_at: now,
            content_updated_at,
            etag: response.etag,
            last_modified: response.last_modified,
        };
        if let Err(err) = cache::write_snapshot(&self.root, &snapshot, &self.limits, self.hooks) {
            self.record_failure(id, &err.to_string(), None);
            return Err(err);
        }
        state.snapshot = Some(snapshot);
        state.checked_at = Some(now);
        state.last_success_at = Some(now);
        state.consecutive_failures = 0;
        state.cooldown_until = None;
        state.backoff_attempt = 0;
        state.next_due_at = Some(self.scheduler.after_success(state.source.interval));
        self.states.lock().unwrap().insert(id.to_owned(), state);
        Ok(FetchOutcome::Fetched { revision })
    }

    fn is_enabled(&self, id: &str) -> bool {
        self.states
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|s| s.source.enabled)
    }

    fn aggregate_bytes_except(&self, skip: &str) -> u64 {
        self.states
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _)| id.as_str() != skip)
            .filter_map(|(_, s)| s.snapshot.as_ref())
            .map(|s| s.content_len() as u64)
            .sum()
    }

    /// Record a failure without touching last-good content. Abusive responses
    /// additionally set a cooldown that even a forced refresh respects.
    fn record_failure(&self, id: &str, detail: &str, retry_after: Option<Duration>) {
        let mut states = self.states.lock().unwrap();
        if let Some(state) = states.get_mut(id) {
            let attempt = state.backoff_attempt;
            let (until, _delay) = self.scheduler.after_failure(attempt, retry_after);
            state.failure_count = state.failure_count.saturating_add(1);
            state.consecutive_failures = state.consecutive_failures.saturating_add(1);
            state.backoff_attempt = state.backoff_attempt.saturating_add(1);
            state.last_error = Some(Error::bounded_detail(
                detail,
                self.limits.max_diagnostic_bytes,
            ));
            state.next_due_at = Some(until);
            // Cooldown is only an abuse signal (429/503). A generic failure
            // clears a stale one so reports stay truthful.
            state.cooldown_until = retry_after.map(|_| until);
        }
    }

    /// Refresh every enabled source that is due. This convenience path is
    /// sequential (concurrency 1); the async worker uses the configured
    /// semaphore for parallel refreshes up to `max_concurrency`.
    pub async fn refresh_all(&self, force: bool) -> Vec<(String, Result<FetchOutcome, Error>)> {
        let ids: Vec<String> = self
            .states
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, s)| s.source.enabled)
            .map(|(id, _)| id.clone())
            .collect();
        let mut results = Vec::with_capacity(ids.len());
        for id in ids {
            let outcome = self.refresh(&id, force).await;
            results.push((id, outcome));
        }
        results
    }

    /// Explicit enable/disable. This returns immediately; it never waits for
    /// an in-flight refresh. A refresh already in flight re-checks `enabled`
    /// before promotion, so disabling cannot write new bytes afterwards.
    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), Error> {
        let mut states = self.states.lock().unwrap();
        let state = states
            .get_mut(id)
            .ok_or_else(|| Error::UnknownSource(id.to_owned()))?;
        state.source.enabled = enabled;
        if enabled {
            state.next_due_at = None;
        }
        Ok(())
    }

    pub fn status(&self, id: &str) -> Result<SubscriptionReport, Error> {
        let state = self
            .states
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| Error::UnknownSource(id.to_owned()))?;
        Ok(self.report(&state))
    }

    pub fn status_all(&self) -> Vec<SubscriptionReport> {
        let states: Vec<ListState> = self.states.lock().unwrap().values().cloned().collect();
        states.iter().map(|s| self.report(s)).collect()
    }

    fn report(&self, state: &ListState) -> SubscriptionReport {
        let stale = self
            .scheduler
            .is_stale(state.checked_at, state.source.max_stale);
        let status = if !state.source.enabled {
            SubscriptionStatus::Disabled
        } else if state.snapshot.is_none() {
            SubscriptionStatus::NeverFetched
        } else if state.consecutive_failures > 0 {
            SubscriptionStatus::FailedWithLastGood
        } else if stale {
            SubscriptionStatus::Stale
        } else {
            SubscriptionStatus::Fresh
        };
        let snapshot = state.snapshot.as_ref();
        SubscriptionReport {
            id: state.source.id.clone(),
            status,
            enabled: state.source.enabled,
            url: state.source.url.safe_display(),
            title: state.source.metadata.title.clone(),
            publisher: state.source.metadata.publisher.clone(),
            license: state.source.metadata.license.clone(),
            interval_secs: state.source.interval.as_secs(),
            max_stale_secs: state.source.max_stale.as_secs(),
            checked_at: state.checked_at,
            fetched_at: snapshot.map(|s| s.fetched_at),
            content_updated_at: snapshot.and_then(|s| s.content_updated_at),
            last_success_at: state.last_success_at,
            revision: snapshot.map_or(0, |s| s.revision),
            content_version: snapshot.map(|s| s.content_version().to_owned()),
            rule_count: snapshot.map(|s| s.rule_count),
            bytes: snapshot.map_or(0, |s| s.content_len()),
            validator_version: self.validator_version,
            cached_validator_version: snapshot.map(|s| s.validator_version),
            failure_count: state.failure_count,
            consecutive_failures: state.consecutive_failures,
            last_error: state.last_error.clone(),
            stale,
            next_due_at: state.next_due_at,
            cooldown_until: state.cooldown_until,
        }
    }

    /// Validated bytes of the current last-known-good list, if any. Consumers
    /// (the future compiler/DNS worker) take it from here; this crate never
    /// interprets it.
    pub fn last_good_bytes(&self, id: &str) -> Result<Option<Vec<u8>>, Error> {
        let states = self.states.lock().unwrap();
        let state = states
            .get(id)
            .ok_or_else(|| Error::UnknownSource(id.to_owned()))?;
        match state.snapshot.as_ref() {
            Some(snapshot) => snapshot.bytes().map(Some),
            None => Ok(None),
        }
    }

    pub fn source_url(&self, id: &str) -> Result<ValidatedUrl, Error> {
        let states = self.states.lock().unwrap();
        states
            .get(id)
            .map(|s| s.source.url.clone())
            .ok_or_else(|| Error::UnknownSource(id.to_owned()))
    }
}

fn parse_http_date(value: &str) -> Option<DateTime<Utc>> {
    let clean = value.trim();
    chrono::DateTime::parse_from_rfc2822(clean)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}
