use super::*;
use std::collections::HashSet;

struct TempRoot(PathBuf);
impl TempRoot {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("vantyr-retention-{}", Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn day(&self, agent: Uuid, day: &str) -> PathBuf {
        let path = self.0.join(agent.to_string()).join(day);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("fixture.jpg"), b"fixture").unwrap();
        path
    }
}
impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn cutoff() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 1, 1).unwrap()
}

#[test]
fn only_canonical_old_uuid_days_are_candidates_and_unsafe_paths_are_refused() {
    let root = TempRoot::new();
    let agent = Uuid::new_v4();
    let old = root.day(agent, "20251231");
    let current = root.day(agent, "20260101");
    let invalid = root.day(agent, "20260230");
    let non_owner = root.0.join("not-a-device/20250101");
    std::fs::create_dir_all(&non_owner).unwrap();
    let upper = root
        .0
        .join(agent.to_string().to_uppercase())
        .join("20250101");
    std::fs::create_dir_all(&upper).unwrap();
    let mut scan = Scan::default();
    let batch = scan.batch(&root.0, cutoff()).unwrap();
    assert!(batch.complete);
    assert_eq!(batch.candidates.len(), 1);
    assert_eq!(batch.candidates[0].path, old);
    assert!(remove_day(&root.0, &non_owner).is_err());
    assert!(remove_day(&root.0, &invalid).is_err());
    assert!(remove_day(&root.0, &root.0.join("../elsewhere")).is_err());
    remove_day(&root.0, &old).unwrap();
    assert!(!old.exists());
    assert!(current.exists());
    assert!(upper.exists());
}

#[test]
fn scan_cursor_is_bounded_and_eventually_reaches_other_devices() {
    let root = TempRoot::new();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    // More than one entry batch in the first device, including ineligible names.
    for i in 0..600 {
        std::fs::create_dir_all(root.0.join(a.to_string()).join(format!("ignored-{i}"))).unwrap();
    }
    for i in 0..70 {
        let day = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap() + chrono::Duration::days(i);
        root.day(a, &day.format("%Y%m%d").to_string());
    }
    root.day(b, "20250101");
    let mut scan = Scan::default();
    let mut seen = HashSet::new();
    let mut finished = false;
    for _ in 0..10 {
        let batch = scan.batch(&root.0, cutoff()).unwrap();
        assert!(batch.scanned <= SCAN_ENTRIES);
        assert!(batch.candidates.len() <= CANDIDATES);
        assert!(batch.failures.is_empty());
        for candidate in batch.candidates {
            assert!(seen.insert(candidate.path));
        }
        if batch.complete {
            finished = true;
            break;
        }
    }
    assert!(finished);
    assert_eq!(seen.len(), 71);
    assert!(seen.contains(&root.0.join(b.to_string()).join("20250101")));
}

#[cfg(unix)]
#[test]
fn static_symlink_days_devices_roots_and_ancestors_never_delete_external_files() {
    use std::os::unix::fs::symlink;
    let root = TempRoot::new();
    let external = TempRoot::new();
    let agent = Uuid::new_v4();
    let victim = external.day(agent, "20250101");
    let device = root.0.join(agent.to_string());
    std::fs::create_dir(&device).unwrap();
    let link = device.join("20250101");
    symlink(&victim, &link).unwrap();
    assert!(remove_day(&root.0, &link).is_err());
    let mut scan = Scan::default();
    let batch = scan.batch(&root.0, cutoff()).unwrap();
    assert!(batch.candidates.is_empty());
    assert_eq!(batch.failures.len(), 1);
    std::fs::remove_file(&link).unwrap();
    std::fs::remove_dir(&device).unwrap();
    symlink(victim.parent().unwrap(), &device).unwrap();
    assert!(scan.batch(&root.0, cutoff()).unwrap().candidates.is_empty());
    let alias = root.0.join("alias");
    symlink(&external.0, &alias).unwrap();
    assert!(Scan::default().batch(&alias, cutoff()).is_err());
    assert!(checked_directory(&alias.join(agent.to_string())).is_err());
    assert!(victim.join("fixture.jpg").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_caller_and_timeout_cannot_release_running_removal_locks() {
    let job_lock = Arc::new(AsyncMutex::new(()));
    let gate = Arc::new(tokio::sync::RwLock::new(()));
    let job = Arc::new(job_lock.clone().lock_owned().await);
    let lease = gate.clone().write_owned().await;
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (finish_tx, finish_rx) = std::sync::mpsc::channel();
    let worker = removal_worker(job, lease, move || {
        started_tx.send(()).unwrap();
        finish_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    });
    let caller = tokio::spawn(async move {
        worker.await.unwrap();
    });
    started_rx.await.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert!(gate.try_read().is_err());
    assert!(job_lock.try_lock().is_err());
    finish_tx.send(()).unwrap();
    let _gate = tokio::time::timeout(Duration::from_secs(2), gate.read())
        .await
        .unwrap();
    let _job = tokio::time::timeout(Duration::from_secs(2), job_lock.lock())
        .await
        .unwrap();
}

async fn fixture() -> Arc<AppState> {
    let (s, _, _) = crate::state::agent_lifecycle::test_support::state()
        .await
        .unwrap();
    sqlx::raw_sql(
        r"
        CREATE TEMP TABLE screen_frames (agent_id UUID, captured_at DATE NOT NULL, blob_ref TEXT)
            PARTITION BY RANGE(captured_at);
        CREATE TEMP TABLE screen_frames_default PARTITION OF screen_frames DEFAULT;
        CREATE TEMP TABLE screen_frames_20250101 PARTITION OF screen_frames
            FOR VALUES FROM('2025-01-01') TO('2025-01-02');
        CREATE TEMP TABLE activity_segments(start_ts TIMESTAMPTZ);
        CREATE TEMP TABLE day_summaries(day DATE);
    ",
    )
    .execute(&s.db)
    .await
    .unwrap();
    std::fs::create_dir(&s.screen_history_dir).unwrap();
    s
}
async fn index(s: &AppState, owner: Uuid, at: &str, reference: &str) {
    sqlx::query("INSERT INTO screen_frames VALUES($1,$2::text::date,$3)")
        .bind(owner)
        .bind(at)
        .bind(reference)
        .execute(&s.db)
        .await
        .unwrap();
}
fn day(s: &AppState, owner: Uuid, at: &str) -> PathBuf {
    let path = s.screen_history_dir.join(owner.to_string()).join(at);
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(path.join("fixture.jpg"), b"fixture").unwrap();
    path
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; temporary PostgreSQL/filesystem fixtures only"]
async fn successful_drop_failed_removal_retries_without_another_partition_drop() {
    let s = fixture().await;
    let outside = TempRoot::new();
    let owner = Uuid::new_v4();
    let victim = outside.day(owner, "20250101");
    let path = s
        .screen_history_dir
        .join(owner.to_string())
        .join("20250101");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&victim, &path).unwrap();
    index(
        &s,
        owner,
        "2025-01-01",
        &format!("{owner}/20250101/fixture.jpg"),
    )
    .await;
    assert!(prune_at(s.clone(), cutoff()).await.is_err());
    let exists: bool =
        sqlx::query_scalar("SELECT to_regclass('pg_temp.screen_frames_20250101') IS NOT NULL")
            .fetch_one(&s.db)
            .await
            .unwrap();
    assert!(
        !exists,
        "drop committed even though its blob day was unsafe"
    );
    assert!(victim.join("fixture.jpg").exists());
    std::fs::remove_file(&path).unwrap();
    day(&s, owner, "20250101");
    let report = prune_at(s.clone(), cutoff()).await.unwrap();
    assert_eq!(report.partitions_dropped, 0);
    assert_eq!(report.removed, 1);
    assert!(report.scan_complete);
    assert!(!path.exists());
    std::fs::remove_dir_all(&s.screen_history_dir).unwrap();
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; temporary PostgreSQL/filesystem fixtures only"]
async fn default_partition_and_cross_owner_references_protect_actual_days() {
    let s = fixture().await;
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let p1 = day(&s, a, "20250102");
    let p2 = day(&s, a, "20250103");
    let orphan = day(&s, b, "20250104");
    let recent = day(&s, b, "20260101");
    index(&s, a, "2025-01-02", &format!("{a}/20250102/fixture.jpg")).await;
    // The row is malformed (another owner and captured date), but its path
    // remains conservative protection rather than permission to erase it.
    index(&s, b, "2026-02-01", &format!("{a}/20250103/fixture.jpg")).await;
    let report = prune_at(s.clone(), cutoff()).await.unwrap();
    assert_eq!(report.protected, 2);
    assert_eq!(report.removed, 1);
    assert!(p1.exists() && p2.exists() && recent.exists());
    assert!(!orphan.exists());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM screen_frames")
            .fetch_one(&s.db)
            .await
            .unwrap(),
        2
    );
    std::fs::remove_dir_all(&s.screen_history_dir).unwrap();
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; temporary PostgreSQL/filesystem fixtures only"]
async fn bounded_partition_batches_skip_invalid_names_and_touch_only_resolved_parent() {
    let s = fixture().await;
    for (name, at) in [
        ("00000000", "2025-01-02"),
        ("20250230", "2025-01-03"),
        ("20251301", "2025-01-04"),
        ("20250000", "2025-01-05"),
    ] {
        sqlx::query(&format!("CREATE TEMP TABLE screen_frames_{name} PARTITION OF screen_frames FOR VALUES FROM('{at}') TO('{}')", (NaiveDate::parse_from_str(at, "%Y-%m-%d").unwrap()+chrono::Duration::days(1))))
            .execute(&s.db).await.unwrap();
    }
    for at in [
        "2025-02-01",
        "2025-02-02",
        "2025-02-03",
        "2025-02-04",
        "2025-02-05",
    ] {
        let start = NaiveDate::parse_from_str(at, "%Y-%m-%d").unwrap();
        sqlx::query(&format!("CREATE TEMP TABLE screen_frames_{} PARTITION OF screen_frames FOR VALUES FROM('{start}') TO('{}')",start.format("%Y%m%d"),start+chrono::Duration::days(1)))
            .execute(&s.db).await.unwrap();
    }
    sqlx::raw_sql("CREATE TEMP TABLE unrelated_frames(captured_at DATE) PARTITION BY RANGE(captured_at); CREATE TEMP TABLE screen_frames_20240101 PARTITION OF unrelated_frames FOR VALUES FROM('2024-01-01') TO('2024-01-02');")
        .execute(&s.db).await.unwrap();
    assert_eq!(
        db::prune_screen_history_partitions(&s.db, cutoff())
            .await
            .unwrap(),
        4
    );
    assert_eq!(
        db::prune_screen_history_partitions(&s.db, cutoff())
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        db::prune_screen_history_partitions(&s.db, cutoff())
            .await
            .unwrap(),
        0
    );
    assert!(sqlx::query_scalar::<_, bool>("SELECT to_regclass('pg_temp.screen_frames_20240101') IS NOT NULL AND to_regclass('pg_temp.screen_frames_00000000') IS NOT NULL").fetch_one(&s.db).await.unwrap());
    std::fs::remove_dir_all(&s.screen_history_dir).unwrap();
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; temporary PostgreSQL/filesystem fixtures only"]
async fn cancelled_prune_keeps_accepted_job_running_and_overlap_is_reported() {
    let s = fixture().await;
    let owner = Uuid::new_v4();
    let path = day(&s, owner, "20250102");
    let gate = s.agent_lifecycle.for_agent(owner);
    let reader = gate.read().await;
    let worker_state = s.clone();
    let caller = tokio::spawn(async move { prune_at(worker_state, cutoff()).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if s.recall_retention.running.try_lock().is_err() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert!(prune_at(s.clone(), cutoff()).await.unwrap().skipped_running);
    assert!(path.exists());
    drop(reader);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if s.recall_retention.running.try_lock().is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(!path.exists());
    std::fs::remove_dir_all(&s.screen_history_dir).unwrap();
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; temporary PostgreSQL/filesystem fixtures only"]
async fn unavailable_reference_table_fails_closed_and_preserves_candidate() {
    let s = fixture().await;
    let owner = Uuid::new_v4();
    let path = day(&s, owner, "20250102");
    // Only this connection's fixture parent is changed. An absent table makes
    // both partition enumeration and the reference check fail deterministically.
    sqlx::raw_sql("ALTER TABLE pg_temp.screen_frames RENAME TO unavailable_fixture_frames")
        .execute(&s.db)
        .await
        .unwrap();
    let error = prune_at(s.clone(), cutoff()).await.unwrap_err().to_string();
    assert!(error.contains("reference check"), "{error}");
    assert!(path.join("fixture.jpg").exists());
    std::fs::remove_dir_all(&s.screen_history_dir).unwrap();
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; temporary PostgreSQL/filesystem fixtures only"]
async fn cooperative_ingestion_reference_commits_before_queued_cleanup_check() {
    let s = fixture().await;
    let owner = Uuid::new_v4();
    let path = day(&s, owner, "20250102");
    let gate = s.agent_lifecycle.for_agent(owner);
    let ingestion = gate.read().await;
    let worker_state = s.clone();
    let cleanup = tokio::spawn(async move { prune_at(worker_state, cutoff()).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            // Tokio's fair lock excludes additional readers once the cleanup
            // writer is queued, although the original ingestion reader remains.
            if gate.try_read().is_err() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    index(
        &s,
        owner,
        "2025-01-02",
        &format!("{owner}/20250102/fixture.jpg"),
    )
    .await;
    drop(ingestion);
    let report = cleanup.await.unwrap().unwrap();
    assert_eq!(report.protected, 1);
    assert_eq!(report.removed, 0);
    assert!(path.join("fixture.jpg").exists());
    std::fs::remove_dir_all(&s.screen_history_dir).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn timed_out_blocking_removal_retains_device_and_coordinator_exclusion() {
    let job_lock = Arc::new(AsyncMutex::new(()));
    let gate = Arc::new(tokio::sync::RwLock::new(()));
    let job = Arc::new(job_lock.clone().lock_owned().await);
    let lease = gate.clone().write_owned().await;
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (finish_tx, finish_rx) = std::sync::mpsc::channel();
    let worker = removal_worker(job, lease, move || {
        started_tx.send(()).unwrap();
        finish_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    });
    started_rx.await.unwrap();
    assert!(tokio::time::timeout(Duration::from_millis(10), worker)
        .await
        .is_err());
    assert!(gate.try_read().is_err());
    assert!(job_lock.try_lock().is_err());
    finish_tx.send(()).unwrap();
    let _gate = tokio::time::timeout(Duration::from_secs(2), gate.read())
        .await
        .unwrap();
    let _job = tokio::time::timeout(Duration::from_secs(2), job_lock.lock())
        .await
        .unwrap();
}
