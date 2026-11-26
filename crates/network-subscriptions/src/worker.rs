//! Optional bounded async worker. No daemon HTTP API is needed for this slice:
//! embedding code drives it through [`WorkerHandle`] plus [`crate::Fetcher`].

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::config::Limits;
use crate::error::Error;
use crate::fetcher::{FetchOutcome, Fetcher};
use crate::validate::CandidateValidator;

/// Completion notification for an integrator. The fetch result is reported
/// verbatim: an embedding worker can surface a failed apply separately instead
/// of mistaking a cached download for an applied DNS filter.
pub type RefreshNotifier = Arc<dyn Fn(&str, &Result<FetchOutcome, Error>) + Send + Sync + 'static>;

/// Cheap handle for shutdown and manual refresh requests.
#[derive(Clone)]
pub struct WorkerHandle {
    shutdown: tokio::sync::watch::Sender<bool>,
    wake: Arc<tokio::sync::Notify>,
    pending: Arc<Mutex<Vec<String>>>,
    /// Only configured source ids may be queued, so an untrusted caller cannot
    /// grow the pending queue with arbitrary strings.
    known: Arc<HashSet<String>>,
    max_pending: usize,
}

impl WorkerHandle {
    /// Signals shutdown without waiting for an in-flight refresh to finish.
    pub fn shutdown(&self) {
        let _ = self.shutdown.send(true);
        self.wake.notify_waiters();
    }

    /// Request a forced refresh of one configured source on the next worker
    /// turn. The fetcher still enforces the abuse cooldown. Unknown ids and a
    /// full bounded queue are ignored, never queued without limit.
    pub fn request_refresh(&self, id: String) {
        if !self.known.contains(&id) {
            return;
        }
        let mut pending = self.pending.lock().unwrap();
        if pending.len() >= self.max_pending {
            return;
        }
        if !pending.contains(&id) {
            pending.push(id);
        }
        self.wake.notify_waiters();
    }

    pub fn is_shutdown(&self) -> bool {
        *self.shutdown.borrow()
    }
}

pub struct SubscriptionWorker<V> {
    fetcher: Arc<Fetcher<V>>,
    limits: Limits,
    tick: Duration,
    handle: WorkerHandle,
    notifier: Option<RefreshNotifier>,
}

impl<V: CandidateValidator + 'static> SubscriptionWorker<V> {
    pub fn new(fetcher: Arc<Fetcher<V>>, limits: Limits) -> Self {
        // Ticking faster than the minimum interval is pointless; 60 s is a
        // bounded upper bound on reaction time to a newly due source.
        let tick = Duration::from_secs(limits.min_interval_secs.min(60));
        let (shutdown, _) = tokio::sync::watch::channel(false);
        let known: HashSet<String> = fetcher
            .status_all()
            .into_iter()
            .map(|report| report.id)
            .collect();
        let max_pending = limits.max_sources.max(1);
        Self {
            fetcher,
            limits,
            tick,
            handle: WorkerHandle {
                shutdown,
                wake: Arc::new(tokio::sync::Notify::new()),
                pending: Arc::new(Mutex::new(Vec::new())),
                known: Arc::new(known),
                max_pending,
            },
            notifier: None,
        }
    }

    /// Observe every refresh completion without changing fetch/promotion
    /// policy. The callback runs on the worker task; it must be cheap.
    pub fn with_notifier(mut self, notifier: RefreshNotifier) -> Self {
        self.notifier = Some(notifier);
        self
    }

    pub fn handle(&self) -> WorkerHandle {
        self.handle.clone()
    }

    /// Run until the handle is shut down. Concurrency is capped by
    /// `limits.max_concurrency`; pending same-id work is serialized by the
    /// fetcher's per-id mutex.
    pub async fn run(self) -> Result<(), Error> {
        let mut shutdown_rx = self.handle.shutdown.subscribe();
        let mut ticker = tokio::time::interval(self.tick);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    self.run_due(false).await;
                }
                _ = self.handle.wake.notified() => {
                    let pending: Vec<String> = {
                        let mut p = self.handle.pending.lock().unwrap();
                        std::mem::take(&mut *p)
                    };
                    if !pending.is_empty() {
                        self.refresh_batch(pending, true).await;
                    }
                }
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        return Ok(());
                    }
                }
            }
        }
    }

    async fn run_due(&self, force: bool) {
        let ids: Vec<String> = self
            .fetcher
            .status_all()
            .into_iter()
            .filter(|report| report.enabled)
            .map(|report| report.id)
            .collect();
        if !ids.is_empty() {
            self.refresh_batch(ids, force).await;
        }
    }

    /// Every configured id gets a turn. `acquire_owned().await` waits for a
    /// permit instead of breaking out of the loop, so an id late in a batch is
    /// never starved by earlier ids that were not due. The number of spawned
    /// tasks is still bounded by `ids.len()` (at most `max_sources`, 32) and
    /// the semaphore, never unbounded.
    async fn refresh_batch(&self, ids: Vec<String>, force: bool) {
        let semaphore = Arc::new(tokio::sync::Semaphore::new(self.limits.max_concurrency));
        let mut tasks = tokio::task::JoinSet::new();
        for id in ids {
            let Ok(permit) = semaphore.clone().acquire_owned().await else {
                break; // semaphore closed: no further work may be started
            };
            let fetcher = self.fetcher.clone();
            let notifier = self.notifier.clone();
            tasks.spawn(async move {
                let _permit = permit;
                let outcome = fetcher.refresh(&id, force).await;
                if let Some(notifier) = notifier {
                    notifier(&id, &outcome);
                }
                outcome
            });
        }
        while tasks.join_next().await.is_some() {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::{TestClock, TestRng};
    use crate::config::{Limits, SourceMetadata, SubscriptionConfig, SubscriptionSource};
    use crate::error::Error;
    use crate::transport::{ConditionalHeaders, HttpTransport, TransportResponse};
    use crate::url::ValidatedUrl;
    use async_trait::async_trait;
    use chrono::Utc;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingTransport {
        calls: Mutex<Vec<String>>,
        rate_limited: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl HttpTransport for RecordingTransport {
        async fn get(
            &self,
            url: &ValidatedUrl,
            _conditional: ConditionalHeaders,
            _max_body_bytes: u64,
        ) -> Result<TransportResponse, Error> {
            let id = url.path().trim_start_matches('/').to_owned();
            self.calls.lock().unwrap().push(id.clone());
            if self.rate_limited.lock().unwrap().contains(&id) {
                return Ok(TransportResponse {
                    status: 429,
                    retry_after: Some("3600".to_owned()),
                    ..Default::default()
                });
            }
            Ok(TransportResponse {
                status: 200,
                body: b"blocked.example.test\n".to_vec(),
                ..Default::default()
            })
        }
    }

    fn config(count: usize, concurrency: usize) -> SubscriptionConfig {
        let limits = Limits {
            max_concurrency: concurrency,
            ..Default::default()
        };
        let sources = (0..count)
            .map(|index| SubscriptionSource {
                id: format!("list-{index}"),
                url: format!("https://lists.invalid/list-{index}"),
                enabled: true,
                interval_secs: None,
                max_stale_secs: None,
                metadata: SourceMetadata {
                    title: "Test list".to_owned(),
                    publisher: "Operator".to_owned(),
                    license: "operator-asserted".to_owned(),
                },
            })
            .collect();
        SubscriptionConfig {
            sources,
            limits,
            query_policy: Default::default(),
        }
    }

    #[tokio::test]
    async fn every_source_gets_a_turn_when_count_exceeds_concurrency() {
        let config = config(6, 2);
        let dir = tempfile::tempdir().unwrap();
        let transport = Arc::new(RecordingTransport::default());
        let fetcher = Arc::new(
            Fetcher::with_transport(
                dir.path().to_path_buf(),
                &config,
                |bytes: &[u8]| {
                    Ok(crate::validate::CompilationSummary {
                        rule_count: bytes.len() as u64,
                    })
                },
                transport.clone(),
            )
            .unwrap(),
        );
        let notified = Arc::new(Mutex::new(Vec::new()));
        let seen = notified.clone();
        let worker = SubscriptionWorker::new(fetcher.clone(), config.limits.clone()).with_notifier(
            Arc::new(move |id, _outcome| {
                seen.lock().unwrap().push(id.to_owned());
            }),
        );
        let handle = worker.handle();
        let task = tokio::spawn(worker.run());
        for _ in 0..200 {
            if notified.lock().unwrap().len() >= 6 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        handle.shutdown();
        task.await.unwrap().unwrap();
        let seen = notified.lock().unwrap();
        assert_eq!(seen.len(), 6, "late ids must not starve: {seen:?}");
        for index in 0..6 {
            assert!(
                seen.contains(&format!("list-{index}")),
                "missing list-{index}"
            );
        }
        assert_eq!(transport.calls.lock().unwrap().len(), 6);
    }

    #[tokio::test]
    async fn unknown_manual_requests_are_bounded_and_cooldown_is_preserved() {
        let config = config(1, 1);
        let dir = tempfile::tempdir().unwrap();
        let transport = Arc::new(RecordingTransport::default());
        transport
            .rate_limited
            .lock()
            .unwrap()
            .push("list-0".to_owned());
        let clock: crate::clock::SharedClock = Arc::new(TestClock::new(Utc::now()));
        let rng: crate::clock::SharedRng = Arc::new(TestRng::new(Vec::new()));
        let fetcher = Arc::new(
            Fetcher::with_transport(
                dir.path().to_path_buf(),
                &config,
                |bytes: &[u8]| {
                    Ok(crate::validate::CompilationSummary {
                        rule_count: bytes.len() as u64,
                    })
                },
                transport.clone(),
            )
            .unwrap()
            .with_timing(clock, rng),
        );
        let worker = SubscriptionWorker::new(fetcher.clone(), config.limits.clone());
        let handle = worker.handle();
        handle.request_refresh("not-configured".to_owned());
        assert!(
            handle.pending.lock().unwrap().is_empty(),
            "unknown ids must never grow the pending queue"
        );

        handle.request_refresh("list-0".to_owned());
        let outcome = fetcher.refresh("list-0", true).await;
        assert!(outcome.is_err(), "429 must fail without promoting anything");
        let second = fetcher.refresh("list-0", true).await;
        assert!(
            matches!(second, Err(Error::AbuseCooldown(..))),
            "forced refresh must still respect the abuse cooldown"
        );
        assert_eq!(
            transport.calls.lock().unwrap().len(),
            1,
            "cooldown must prevent a second network call"
        );
    }
}
