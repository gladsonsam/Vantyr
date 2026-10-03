//! Per-device serialization for socket registration, ingestion, and lifecycle changes.
//!
//! Readers cover ingestion operations. Writers cover registration, credential
//! mutation, connection invalidation, and deletion (including filesystem cleanup).
//! Owned leases may be shared with blocking work so cancelling an async caller
//! cannot release the gate while that work still writes files.

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use tokio::sync::{OwnedRwLockReadGuard, RwLock};
use uuid::Uuid;

pub type IngestionLease = Arc<OwnedRwLockReadGuard<()>>;

#[derive(Default)]
pub struct AgentLifecycle {
    gates: Mutex<HashMap<Uuid, Weak<RwLock<()>>>>,
}

impl AgentLifecycle {
    pub fn for_agent(&self, id: Uuid) -> Arc<RwLock<()>> {
        let mut gates = self.gates.lock();
        if let Some(gate) = gates.get(&id).and_then(Weak::upgrade) {
            return gate;
        }
        // Sockets retain their own gate, so dead UUID entries need not accumulate.
        gates.retain(|_, gate| gate.strong_count() > 0);
        let gate = Arc::new(RwLock::new(()));
        gates.insert(id, Arc::downgrade(&gate));
        gate
    }
}

/// A blocking worker owns a clone of the lease independently of its async caller.
/// Tokio cannot abort a running blocking task; keep lifecycle writers excluded
/// until the worker actually returns, including after cancellation or panic.
pub fn spawn_blocking_ingestion<T: Send + 'static>(
    lease: &IngestionLease,
    work: impl FnOnce() -> T + Send + 'static,
) -> tokio::task::JoinHandle<T> {
    let lease = lease.clone();
    tokio::task::spawn_blocking(move || {
        let _lease = lease;
        work()
    })
}

#[cfg(test)]
mod lifecycle_concurrency_tests {
    use super::*;

    #[tokio::test]
    async fn gates_are_shared_for_one_uuid_and_independent_for_other_devices() {
        let registry = AgentLifecycle::default();
        let id = Uuid::new_v4();
        let gate = registry.for_agent(id);
        let same = registry.for_agent(id);
        assert!(Arc::ptr_eq(&gate, &same));
        let reader = gate.read().await;
        assert!(same.try_write().is_err());
        assert!(registry.for_agent(Uuid::new_v4()).try_write().is_ok());
        drop(reader);
        drop(same);
        drop(gate);
        let replacement = registry.for_agent(id);
        assert!(replacement.try_write().is_ok());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_ingestion_keeps_deletion_out_until_its_blocking_writer_finishes() {
        let gate = Arc::new(RwLock::new(()));
        let root = std::env::temp_dir().join(format!("vantyr-writer-race-{}", Uuid::new_v4()));
        let file = root.join("20261003/frame.jpg");
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let writer_gate = gate.clone();
        let writer = tokio::spawn(async move {
            let lease = Arc::new(writer_gate.read_owned().await);
            spawn_blocking_ingestion(&lease, move || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                std::fs::write(file, b"jpeg").unwrap();
            })
            .await
            .unwrap();
        });
        started_rx.await.unwrap();
        writer.abort();
        assert!(writer.await.unwrap_err().is_cancelled());
        // The async parent has gone, but its running blocking worker still owns
        // the production lease. A deletion cannot overtake that write.
        assert!(gate.try_write().is_err());
        let delete_gate = gate.clone();
        let deleted_root = root.clone();
        let deletion = tokio::spawn(async move {
            let _exclusive = delete_gate.write_owned().await;
            assert!(deleted_root.join("20261003/frame.jpg").exists());
            std::fs::remove_dir_all(deleted_root).unwrap();
        });
        release_tx.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), deletion)
            .await
            .unwrap()
            .unwrap();
        assert!(
            !root.exists(),
            "the writer must finish before cleanup, not recreate files afterward"
        );
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::state::{AppState, AppStateParams};

    /// Each test gets a single connection with temporary tables shadowing the
    /// application tables. No existing application row is read or changed.
    pub async fn state() -> anyhow::Result<(Arc<AppState>, Uuid, String)> {
        let url = std::env::var("TEST_DATABASE_URL")?;
        let db = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await?;
        sqlx::raw_sql("CREATE TEMP TABLE agents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT UNIQUE NOT NULL, api_token_hash TEXT, first_seen TIMESTAMPTZ DEFAULT NOW(), last_seen TIMESTAMPTZ DEFAULT NOW()); CREATE TEMP TABLE agent_groups (id UUID PRIMARY KEY); CREATE TEMP TABLE agent_sessions (id BIGSERIAL PRIMARY KEY, agent_id UUID REFERENCES agents(id) ON DELETE CASCADE, connected_at TIMESTAMPTZ DEFAULT NOW(), disconnected_at TIMESTAMPTZ); CREATE TEMP TABLE audit_log (actor TEXT, agent_id UUID, action TEXT, status TEXT, detail JSONB, client_ip TEXT);")
            .execute(&db).await?;
        let schema = include_str!("../migrations/0055_agent_enrollment_claims.sql")
            .replace("CREATE TABLE IF NOT EXISTS", "CREATE TEMP TABLE");
        sqlx::raw_sql(&schema).execute(&db).await?;
        let hash = crate::db::hash_dashboard_password("old-token")?;
        let id = sqlx::query_scalar(
            "INSERT INTO agents (name, api_token_hash) VALUES ('device', $1) RETURNING id",
        )
        .bind(&hash)
        .fetch_one(&db)
        .await?;
        let state = Arc::new(AppState::new(AppStateParams {
            db,
            allow_insecure_dashboard_open: false,
            wol_min_interval: std::time::Duration::ZERO,
            allow_remote_script: false,
            metrics: None,
            notify_hub: crate::notify::NotifyHub::new(vec![]),
            integration_api_token: None,
            public_base_url: None,
            agent_listen_port: 0,
            scheduler_tz: chrono_tz::UTC,
            trusted_proxies: Arc::new(crate::trusted_proxy::TrustedProxies::default()),
            screen_history_dir: std::env::temp_dir()
                .join(format!("vantyr-lifecycle-{}", Uuid::new_v4())),
            screen_history_ai: None,
            vapid_public_key: None,
        }));
        Ok((state, id, hash))
    }

    pub fn admin() -> crate::auth::AuthUser {
        crate::auth::AuthUser {
            user_id: Uuid::new_v4(),
            username: "lifecycle-test".into(),
            role: "admin".into(),
            display_name: "Test".into(),
            display_icon: None,
            csrf_token: "test".into(),
        }
    }
}
