//! Optional bounded async worker. No daemon HTTP API is needed for this slice:
//! embedding code drives it through [`WorkerHandle`] plus [`crate::Fetcher`].

use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::config::Limits;
use crate::error::Error;
use crate::fetcher::Fetcher;
use crate::validate::CandidateValidator;

/// Cheap handle for shutdown and manual refresh requests.
#[derive(Clone)]
pub struct WorkerHandle {
    shutdown: tokio::sync::watch::Sender<bool>,
    wake: Arc<tokio::sync::Notify>,
    pending: Arc<Mutex<Vec<String>>>,
}

impl WorkerHandle {
    /// Signals shutdown without waiting for an in-flight refresh to finish.
    pub fn shutdown(&self) {
        let _ = self.shutdown.send(true);
        self.wake.notify_waiters();
    }

    /// Request a forced refresh of one source on the next worker turn. The
    /// fetcher still enforces the abuse cooldown.
    pub fn request_refresh(&self, id: String) {
        let mut pending = self.pending.lock().unwrap();
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
}

impl<V: CandidateValidator + 'static> SubscriptionWorker<V> {
    pub fn new(fetcher: Arc<Fetcher<V>>, limits: Limits) -> Self {
        // Ticking faster than the minimum interval is pointless; 60 s is a
        // bounded upper bound on reaction time to a newly due source.
        let tick = Duration::from_secs(limits.min_interval_secs.min(60));
        let (shutdown, _) = tokio::sync::watch::channel(false);
        Self {
            fetcher,
            limits,
            tick,
            handle: WorkerHandle {
                shutdown,
                wake: Arc::new(tokio::sync::Notify::new()),
                pending: Arc::new(Mutex::new(Vec::new())),
            },
        }
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
            .filter(|r| r.enabled)
            .map(|r| r.id)
            .collect();
        if !ids.is_empty() {
            self.refresh_batch(ids, force).await;
        }
    }

    async fn refresh_batch(&self, ids: Vec<String>, force: bool) {
        let semaphore = Arc::new(tokio::sync::Semaphore::new(self.limits.max_concurrency));
        let mut tasks = tokio::task::JoinSet::new();
        for id in ids {
            let Ok(permit) = semaphore.clone().try_acquire_owned() else {
                break; // leave the rest for the next tick; never grow unbounded
            };
            let fetcher = self.fetcher.clone();
            tasks.spawn(async move {
                let _permit = permit;
                let _ = fetcher.refresh(&id, force).await;
            });
        }
        while tasks.join_next().await.is_some() {}
    }
}
