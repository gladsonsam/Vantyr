use super::*;
use crate::recall::db;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;
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
    assert!(detach_day(&root.0, &non_owner).is_err());
    assert!(detach_day(&root.0, &invalid).is_err());
    assert!(detach_day(&root.0, &root.0.join("../elsewhere")).is_err());
    detach_day(&root.0, &old).unwrap();
    assert!(!old.exists());
    assert!(current.exists());
    assert!(upper.exists());
    // The detached day is only in the trash, which the device scan never visits.
    let trash = root.0.join(TRASH_DIR);
    assert_eq!(std::fs::read_dir(&trash).unwrap().count(), 1);
    assert!(Scan::default()
        .batch(&root.0, cutoff())
        .unwrap()
        .candidates
        .is_empty());
    purge_trash(&root.0).unwrap();
    assert!(!trash.exists());
    purge_trash(&root.0).unwrap();
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
    assert!(detach_day(&root.0, &link).is_err());
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
    // A symlinked trash is neither a rename target nor purged through.
    std::fs::remove_file(&device).unwrap();
    let day = root.day(agent, "20250101");
    symlink(&external.0, root.0.join(TRASH_DIR)).unwrap();
    assert!(detach_day(&root.0, &day).is_err());
    assert!(purge_trash(&root.0).is_err());
    assert!(day.join("fixture.jpg").exists());
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

/// The migrated schema (`screen_frames` partitioned by day with a DEFAULT child) plus one
/// expired day partition, and an empty screen-history root.
async fn fixture(db: PgPool) -> Arc<AppState> {
    let s = crate::test_support::app_state(db);
    sqlx::raw_sql(
        "CREATE TABLE screen_frames_20250101 PARTITION OF screen_frames
            FOR VALUES FROM('2025-01-01') TO('2025-01-02');",
    )
    .execute(&s.db)
    .await
    .unwrap();
    std::fs::create_dir(&s.settings.screen_history_dir).unwrap();
    s
}
/// A device row for `owner`, so frames can reference it.
async fn device(s: &AppState, owner: Uuid) -> Uuid {
    crate::test_support::insert_agent(&s.db, owner)
        .await
        .unwrap();
    owner
}
async fn index(s: &AppState, owner: Uuid, at: &str, reference: &str) {
    device(s, owner).await;
    sqlx::query("INSERT INTO screen_frames(agent_id,captured_at,w,h,phash,blob_ref) VALUES($1,$2::text::timestamptz,10,10,0,$3)")
        .bind(owner)
        .bind(at)
        .bind(reference)
        .execute(&s.db)
        .await
        .unwrap();
}
fn day(s: &AppState, owner: Uuid, at: &str) -> PathBuf {
    let path = s
        .settings
        .screen_history_dir
        .join(owner.to_string())
        .join(at);
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(path.join("fixture.jpg"), b"fixture").unwrap();
    path
}

#[cfg(unix)]
#[sqlx::test]
async fn successful_drop_failed_removal_retries_without_another_partition_drop(db: PgPool) {
    let s = fixture(db).await;
    let outside = TempRoot::new();
    let owner = Uuid::new_v4();
    let victim = outside.day(owner, "20250101");
    let path = s
        .settings
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
        sqlx::query_scalar("SELECT to_regclass('screen_frames_20250101') IS NOT NULL")
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
    std::fs::remove_dir_all(&s.settings.screen_history_dir).unwrap();
}

#[sqlx::test]
async fn expired_default_rows_are_pruned_and_current_owner_references_protect_days(db: PgPool) {
    let s = fixture(db).await;
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let p1 = day(&s, a, "20250102");
    let edge = day(&s, a, "20251231");
    let foreign = day(&s, a, "20250103");
    let orphan = day(&s, b, "20250104");
    let recent = day(&s, b, "20260101");
    index(&s, a, "2025-01-02", &format!("{a}/20250102/fixture.jpg")).await;
    // A current row just past the folder's UTC day stays within the bounded
    // reference window and keeps its path.
    index(
        &s,
        a,
        "2026-01-01 00:30:00+00",
        &format!("{a}/20251231/fixture.jpg"),
    )
    .await;
    // Ingestion never writes another device's path; the indexed reference check
    // is scoped to the owning device, so such a row does not pin the folder.
    index(&s, b, "2026-02-01", &format!("{a}/20250103/fixture.jpg")).await;
    let report = prune_at(s.clone(), cutoff()).await.unwrap();
    assert_eq!(report.default_batches_attempted, 1);
    assert_eq!(report.default_batches_committed, 1);
    assert_eq!(report.default_rows_deleted, 1);
    assert_eq!(report.default_rows_pending, Some(false));
    assert_eq!(report.default_prune_failures, 0);
    assert_eq!(report.protected, 1);
    assert_eq!(report.removed, 3);
    assert!(!p1.exists() && edge.exists() && recent.exists());
    assert!(!foreign.exists() && !orphan.exists());
    assert!(!s.settings.screen_history_dir.join(TRASH_DIR).exists());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM screen_frames")
            .fetch_one(&s.db)
            .await
            .unwrap(),
        2
    );
    std::fs::remove_dir_all(&s.settings.screen_history_dir).unwrap();
}

#[sqlx::test]
async fn bounded_partition_batches_skip_invalid_names_and_touch_only_resolved_parent(db: PgPool) {
    let s = fixture(db).await;
    for (name, at) in [
        ("00000000", "2025-01-02"),
        ("20250230", "2025-01-03"),
        ("20251301", "2025-01-04"),
        ("20250000", "2025-01-05"),
    ] {
        sqlx::query(&format!("CREATE TABLE screen_frames_{name} PARTITION OF screen_frames FOR VALUES FROM('{at}') TO('{}')", (NaiveDate::parse_from_str(at, "%Y-%m-%d").unwrap()+chrono::Duration::days(1))))
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
        sqlx::query(&format!("CREATE TABLE screen_frames_{} PARTITION OF screen_frames FOR VALUES FROM('{start}') TO('{}')",start.format("%Y%m%d"),start+chrono::Duration::days(1)))
            .execute(&s.db).await.unwrap();
    }
    sqlx::raw_sql("CREATE TABLE unrelated_frames(captured_at DATE) PARTITION BY RANGE(captured_at); CREATE TABLE screen_frames_20240101 PARTITION OF unrelated_frames FOR VALUES FROM('2024-01-01') TO('2024-01-02');")
        .execute(&s.db).await.unwrap();
    assert_eq!(
        db::partitions::prune_screen_history_partitions(&s.db, cutoff())
            .await
            .unwrap(),
        4
    );
    assert_eq!(
        db::partitions::prune_screen_history_partitions(&s.db, cutoff())
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        db::partitions::prune_screen_history_partitions(&s.db, cutoff())
            .await
            .unwrap(),
        0
    );
    assert!(sqlx::query_scalar::<_, bool>("SELECT to_regclass('screen_frames_20240101') IS NOT NULL AND to_regclass('screen_frames_00000000') IS NOT NULL").fetch_one(&s.db).await.unwrap());
    std::fs::remove_dir_all(&s.settings.screen_history_dir).unwrap();
}

#[sqlx::test]
async fn cancelled_prune_keeps_accepted_job_running_and_overlap_is_reported(db: PgPool) {
    let s = fixture(db).await;
    let owner = Uuid::new_v4();
    let path = day(&s, owner, "20250102");
    let gate = s.agents.lifecycle.for_agent(owner);
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
    std::fs::remove_dir_all(&s.settings.screen_history_dir).unwrap();
}

#[sqlx::test]
async fn unavailable_reference_table_fails_closed_and_preserves_candidate(db: PgPool) {
    let s = fixture(db).await;
    let owner = Uuid::new_v4();
    let path = day(&s, owner, "20250102");
    // Only this test's database is changed. An absent table makes both
    // partition enumeration and the reference check fail deterministically.
    sqlx::raw_sql("ALTER TABLE screen_frames RENAME TO unavailable_fixture_frames")
        .execute(&s.db)
        .await
        .unwrap();
    let error = prune_at(s.clone(), cutoff()).await.unwrap_err().to_string();
    assert!(error.contains("reference check"), "{error}");
    assert!(path.join("fixture.jpg").exists());
    std::fs::remove_dir_all(&s.settings.screen_history_dir).unwrap();
}

#[sqlx::test]
async fn cooperative_ingestion_reference_commits_before_queued_cleanup_check(db: PgPool) {
    let s = fixture(db).await;
    let owner = Uuid::new_v4();
    let path = day(&s, owner, "20250102");
    let gate = s.agents.lifecycle.for_agent(owner);
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
    // This expired upload arrived after the DEFAULT batch. It remains accepted
    // and protects its path until a later retention pass prunes it.
    let later = prune_at(s.clone(), cutoff()).await.unwrap();
    assert_eq!(later.default_rows_deleted, 1);
    assert_eq!(later.removed, 1);
    assert!(!path.exists());
    std::fs::remove_dir_all(&s.settings.screen_history_dir).unwrap();
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

#[sqlx::test]
async fn default_batches_bound_rows_make_progress_and_use_utc_boundary(
    pool_options: PgPoolOptions,
    connect_options: PgConnectOptions,
) {
    // Every session runs in a non-UTC zone; the cutoff must still be a UTC boundary.
    let db = pool_options
        .connect_with(connect_options.options([("TimeZone", "Australia/Perth")]))
        .await
        .unwrap();
    let s = fixture(db.clone()).await;
    let owner = device(&s, Uuid::new_v4()).await;
    sqlx::query(
        "INSERT INTO screen_frames(agent_id,captured_at,w,h,phash,blob_ref)
          SELECT $1, '2025-12-31 23:59:59.999999+00', 10, 10, 0, 'expired'
          FROM generate_series(1, 600)",
    )
    .bind(owner)
    .execute(&s.db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO screen_frames(agent_id,captured_at,w,h,phash,blob_ref) VALUES
          ($1, '2026-01-01 08:00:00+08', 10, 10, 0, 'boundary'),
          ($1, '2026-01-02 00:00:00+00', 10, 10, 0, 'recent')",
    )
    .bind(owner)
    .execute(&s.db)
    .await
    .unwrap();
    for (deleted, pending) in [(256, true), (256, true), (88, false), (0, false)] {
        let batch = db::partitions::prune_screen_history_default(&s.db, cutoff())
            .await
            .unwrap();
        assert_eq!(batch.deleted, deleted);
        assert_eq!(batch.pending, pending);
    }
    let refs: Vec<String> =
        sqlx::query_scalar("SELECT blob_ref FROM screen_frames ORDER BY captured_at")
            .fetch_all(&s.db)
            .await
            .unwrap();
    assert_eq!(refs, ["boundary", "recent"]);
    std::fs::remove_dir_all(&s.settings.screen_history_dir).unwrap();
    db.close().await;
}

#[sqlx::test]
async fn default_catalog_identity_uses_quoted_actual_child_and_ignores_decoy(db: PgPool) {
    let s = fixture(db).await;
    sqlx::raw_sql(
        r#"
        ALTER TABLE screen_frames_default RENAME TO "odd default""child";
    "#,
    )
    .execute(&s.db)
    .await
    .unwrap();
    sqlx::raw_sql(
        "CREATE TABLE unrelated(captured_at TIMESTAMPTZ) PARTITION BY RANGE(captured_at);
        CREATE TABLE screen_frames_default PARTITION OF unrelated DEFAULT;
        INSERT INTO unrelated VALUES('2020-01-01');",
    )
    .execute(&s.db)
    .await
    .unwrap();
    index(&s, Uuid::new_v4(), "2025-01-02", "expired").await;
    let batch = db::partitions::prune_screen_history_default(&s.db, cutoff())
        .await
        .unwrap();
    assert_eq!(batch.deleted, 1);
    assert!(!batch.pending);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM screen_frames_default")
            .fetch_one(&s.db)
            .await
            .unwrap(),
        1
    );
    std::fs::remove_dir_all(&s.settings.screen_history_dir).unwrap();
}

#[sqlx::test]
async fn default_delete_failure_rolls_back_entire_batch_and_preserves_indexed_paths(db: PgPool) {
    let s = fixture(db).await;
    let owner = Uuid::new_v4();
    let path = day(&s, owner, "20250102");
    index(
        &s,
        owner,
        "2025-01-02",
        &format!("{owner}/20250102/fixture.jpg"),
    )
    .await;
    index(&s, owner, "2025-01-03", "fail").await;
    sqlx::raw_sql("CREATE FUNCTION reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF OLD.blob_ref='fail' THEN RAISE EXCEPTION 'fixture rejection'; END IF; RETURN OLD; END $$;
        CREATE TRIGGER reject_delete BEFORE DELETE ON screen_frames_default
          FOR EACH ROW EXECUTE FUNCTION reject_delete();")
        .execute(&s.db).await.unwrap();
    let error = prune_at(s.clone(), cutoff()).await.unwrap_err().to_string();
    assert!(error.contains("default_prune_failures: 1"), "{error}");
    assert!(error.contains("default_batches_committed: 0"), "{error}");
    assert!(error.contains("default_rows_deleted: 0"), "{error}");
    assert!(error.contains("default_rows_pending: None"), "{error}");
    assert!(path.join("fixture.jpg").exists());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM screen_frames")
            .fetch_one(&s.db)
            .await
            .unwrap(),
        2
    );
    sqlx::raw_sql("DROP TRIGGER reject_delete ON screen_frames_default")
        .execute(&s.db)
        .await
        .unwrap();
    let report = prune_at(s.clone(), cutoff()).await.unwrap();
    assert_eq!(report.default_rows_deleted, 2);
    assert_eq!(report.removed, 1);
    assert!(!path.exists());
    std::fs::remove_dir_all(&s.settings.screen_history_dir).unwrap();
}

#[sqlx::test]
async fn unsupported_default_subpartition_and_plain_parent_fail_explicitly(db: PgPool) {
    let s = fixture(db).await;
    sqlx::raw_sql("DROP TABLE screen_frames_default;
        CREATE TABLE nested_default PARTITION OF screen_frames DEFAULT PARTITION BY RANGE(captured_at);
        CREATE TABLE nested_leaf PARTITION OF nested_default DEFAULT;")
        .execute(&s.db).await.unwrap();
    index(&s, Uuid::new_v4(), "2025-01-02", "protected").await;
    let error = db::partitions::prune_screen_history_default(&s.db, cutoff())
        .await
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("unsupported screen_frames DEFAULT child"),
        "{error}"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM nested_leaf")
            .fetch_one(&s.db)
            .await
            .unwrap(),
        1
    );
    sqlx::raw_sql(
        "DROP TABLE screen_frames; CREATE TABLE screen_frames(captured_at TIMESTAMPTZ);
        INSERT INTO screen_frames VALUES('2025-01-02');",
    )
    .execute(&s.db)
    .await
    .unwrap();
    let error = db::partitions::prune_screen_history_default(&s.db, cutoff())
        .await
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("unsupported screen_frames partition structure"),
        "{error}"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM screen_frames")
            .fetch_one(&s.db)
            .await
            .unwrap(),
        1
    );
    std::fs::remove_dir_all(&s.settings.screen_history_dir).unwrap();
}

#[sqlx::test]
async fn default_named_like_old_day_is_never_dropped_or_recent_rows_pruned(db: PgPool) {
    let s = fixture(db).await;
    sqlx::raw_sql("ALTER TABLE screen_frames_default RENAME TO screen_frames_20240101")
        .execute(&s.db)
        .await
        .unwrap();
    let owner = Uuid::new_v4();
    let path = day(&s, owner, "20251231");
    index(
        &s,
        owner,
        "2026-01-01 00:30:00+00",
        &format!("{owner}/20251231/fixture.jpg"),
    )
    .await;
    let report = prune_at(s.clone(), cutoff()).await.unwrap();
    assert_eq!(report.partitions_dropped, 1);
    assert_eq!(report.default_rows_deleted, 0);
    assert_eq!(report.protected, 1);
    assert!(path.exists());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM screen_frames_20240101")
            .fetch_one(&s.db)
            .await
            .unwrap(),
        1
    );
    std::fs::remove_dir_all(&s.settings.screen_history_dir).unwrap();
}

#[sqlx::test]
async fn default_statement_timeout_rolls_back_and_cleanup_keeps_reference(db: PgPool) {
    let s = fixture(db).await;
    let owner = Uuid::new_v4();
    let path = day(&s, owner, "20250102");
    index(
        &s,
        owner,
        "2025-01-02",
        &format!("{owner}/20250102/fixture.jpg"),
    )
    .await;
    sqlx::raw_sql(
        "CREATE FUNCTION slow_delete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(3); RETURN OLD; END $$;
        CREATE TRIGGER slow_delete BEFORE DELETE ON screen_frames_default
          FOR EACH ROW EXECUTE FUNCTION slow_delete();",
    )
    .execute(&s.db)
    .await
    .unwrap();
    let error = prune_at(s.clone(), cutoff()).await.unwrap_err().to_string();
    assert!(error.contains("default_prune_failures: 1"), "{error}");
    assert!(error.contains("default_rows_deleted: 0"), "{error}");
    assert!(error.contains("protected: 1"), "{error}");
    assert!(path.join("fixture.jpg").exists());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM screen_frames")
            .fetch_one(&s.db)
            .await
            .unwrap(),
        1
    );
    std::fs::remove_dir_all(&s.settings.screen_history_dir).unwrap();
}

/// Cross-session locks need relations shared by several sessions: a minimal
/// `screen_frames` whose DEFAULT child is `actual_default`, created in this test's
/// own unmigrated database, and one single-connection pool per session.
struct SharedDefaultFixture {
    worker: PgPool,
    observer: PgPool,
}

impl SharedDefaultFixture {
    async fn new(pool_options: PgPoolOptions, connect_options: PgConnectOptions) -> Result<Self> {
        let session = || {
            pool_options
                .clone()
                .max_connections(1)
                .connect_with(connect_options.clone())
        };
        let worker = session().await?;
        sqlx::raw_sql(
            "CREATE TABLE screen_frames(id INT, captured_at TIMESTAMPTZ NOT NULL, blob_ref TEXT)
               PARTITION BY RANGE(captured_at);
             CREATE TABLE actual_default PARTITION OF screen_frames DEFAULT;
             INSERT INTO screen_frames VALUES
               (1, '2025-12-30 00:00:00+00', 'locked'),
               (2, '2025-12-31 00:00:00+00', 'other expired'),
               (3, '2026-01-01 00:00:00+00', 'boundary'),
               (4, '2026-01-02 00:00:00+00', 'current');",
        )
        .execute(&worker)
        .await?;
        let observer = session().await?;
        Ok(Self { worker, observer })
    }

    async fn slow_trigger(&self) -> Result<()> {
        // Only one selected row sleeps, keeping successful work within the
        // helper's real two-second statement budget. No runtime test hooks.
        sqlx::raw_sql(
            "CREATE FUNCTION pause_delete() RETURNS trigger LANGUAGE plpgsql AS $$
               BEGIN IF OLD.id=2 THEN PERFORM pg_sleep(1.5); END IF; RETURN OLD; END $$;
             CREATE TRIGGER pause_delete BEFORE DELETE ON actual_default
               FOR EACH ROW EXECUTE FUNCTION pause_delete();",
        )
        .execute(&self.worker)
        .await?;
        Ok(())
    }

    async fn wait_until_deleting(&self, pid: i32) -> Result<()> {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let sleeping: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                     WHERE pid=$1 AND wait_event='PgSleep')",
                )
                .bind(pid)
                .fetch_one(&self.observer)
                .await?;
                if sleeping {
                    return Ok::<_, anyhow::Error>(());
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await??;
        Ok(())
    }

    async fn ids(&self) -> Result<Vec<i32>> {
        Ok(
            sqlx::query_scalar("SELECT id FROM screen_frames ORDER BY id")
                .fetch_all(&self.worker)
                .await?,
        )
    }

    async fn close(self) {
        self.worker.close().await;
        self.observer.close().await;
    }
}

#[sqlx::test(migrations = false)]
async fn cross_session_default_skip_locked_progress_and_pending_are_real(
    pool_options: PgPoolOptions,
    connect_options: PgConnectOptions,
) -> Result<()> {
    let f = SharedDefaultFixture::new(pool_options, connect_options).await?;
    let result: Result<()> = async {
        let mut locked = f.observer.begin().await?;
        sqlx::query("SELECT id FROM actual_default WHERE id=1 FOR UPDATE")
            .fetch_one(&mut *locked)
            .await?;
        let batch = tokio::time::timeout(
            Duration::from_secs(3),
            db::partitions::prune_screen_history_default(&f.worker, cutoff()),
        )
        .await??;
        anyhow::ensure!(batch.deleted == 1 && batch.pending, "{batch:?}");
        anyhow::ensure!(
            f.ids().await? == [1, 3, 4],
            "locked or current rows changed"
        );
        // Even an entirely locked expired backlog is pending, not complete.
        let batch = db::partitions::prune_screen_history_default(&f.worker, cutoff()).await?;
        anyhow::ensure!(batch.deleted == 0 && batch.pending, "{batch:?}");
        locked.rollback().await?;
        let batch = db::partitions::prune_screen_history_default(&f.worker, cutoff()).await?;
        anyhow::ensure!(batch.deleted == 1 && !batch.pending, "{batch:?}");
        anyhow::ensure!(f.ids().await? == [3, 4], "current rows changed");
        Ok(())
    }
    .await;
    f.close().await;
    result
}

#[sqlx::test(migrations = false)]
async fn cross_session_default_prune_blocks_parent_detach_and_child_rename(
    pool_options: PgPoolOptions,
    connect_options: PgConnectOptions,
) -> Result<()> {
    let f = SharedDefaultFixture::new(pool_options, connect_options).await?;
    let result: Result<()> = async {
        f.slow_trigger().await?;
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&f.worker)
            .await?;
        let worker = f.worker.clone();
        let pruning =
            tokio::spawn(async move { db::partitions::prune_screen_history_default(&worker, cutoff()).await });
        let checked: Result<()> = async {
            f.wait_until_deleting(pid).await?;
            sqlx::query("SET lock_timeout='100ms'")
                .execute(&f.observer)
                .await?;
            // The real pruning locks permit a concurrent current upload.
            sqlx::query("INSERT INTO screen_frames VALUES(5, '2026-01-03 00:00:00+00', 'concurrent current')")
                .execute(&f.observer).await?;
            for ddl in [
                "ALTER TABLE screen_frames DETACH PARTITION actual_default",
                "ALTER TABLE actual_default RENAME TO replaced_default",
            ] {
                let error = match sqlx::query(ddl).execute(&f.observer).await {
                    Err(error) => error,
                    Ok(_) => anyhow::bail!("fixture DDL succeeded during pruning: {ddl}"),
                };
                anyhow::ensure!(
                    error.as_database_error().and_then(|e| e.code()).as_deref() == Some("55P03"),
                    "unexpected DDL error: {error}"
                );
            }
            Ok(())
        }
        .await;
        // Always join the worker before cleanup, including assertion failures.
        let batch = pruning.await??;
        checked?;
        anyhow::ensure!(batch.deleted == 2 && !batch.pending, "{batch:?}");
        anyhow::ensure!(f.ids().await? == [3, 4, 5], "current rows changed");
        let attached: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM pg_partitioned_table
             WHERE partrelid='screen_frames'::regclass AND partdefid='actual_default'::regclass)",
        )
        .fetch_one(&f.worker)
        .await?;
        anyhow::ensure!(
            attached,
            "DDL changed DEFAULT identity despite lock timeout"
        );
        Ok(())
    }
    .await;
    f.close().await;
    result
}

#[sqlx::test(migrations = false)]
async fn cross_session_cancelled_default_transaction_rolls_back_and_releases_locks(
    pool_options: PgPoolOptions,
    connect_options: PgConnectOptions,
) -> Result<()> {
    let f = SharedDefaultFixture::new(pool_options, connect_options).await?;
    let result: Result<()> = async {
        f.slow_trigger().await?;
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&f.worker)
            .await?;
        let worker = f.worker.clone();
        let pruning = tokio::spawn(async move {
            db::partitions::prune_screen_history_default(&worker, cutoff()).await
        });
        let ready = f.wait_until_deleting(pid).await;
        pruning.abort();
        let stopped = pruning.await;
        ready?;
        anyhow::ensure!(
            stopped.is_err_and(|e| e.is_cancelled()),
            "helper was not cancelled"
        );
        // Reusing this connection flushes sqlx's queued transaction rollback.
        let ids = tokio::time::timeout(Duration::from_secs(4), f.ids()).await??;
        anyhow::ensure!(
            ids == [1, 2, 3, 4],
            "partial DELETE survived cancellation: {ids:?}"
        );
        let mut tx = f.observer.begin().await?;
        sqlx::query("SET LOCAL lock_timeout='100ms'")
            .execute(&mut *tx)
            .await?;
        sqlx::query("LOCK TABLE ONLY screen_frames IN ACCESS EXCLUSIVE MODE")
            .execute(&mut *tx)
            .await?;
        sqlx::query("LOCK TABLE ONLY actual_default IN ACCESS EXCLUSIVE MODE")
            .execute(&mut *tx)
            .await?;
        tx.rollback().await?;
        Ok(())
    }
    .await;
    f.close().await;
    result
}
