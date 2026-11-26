//! Worker-local last-known-good (LKG) policy snapshot persistence.
//!
//! A Vantyr DNS / Vantyr Proxy worker keeps the last policy it actually
//! applied on local disk, independent of whether the controller ever received
//! its acknowledgement. On restart the worker loads that locally validated
//! snapshot instead of falling back to an empty or more permissive policy.
//!
//! This is local-disk durability, **not** controller authentication. There is
//! no signature, MAC or hash pretending to prove controller origin. Anything
//! with write access to the directory can forge the file; controller
//! credentials and canaries are a separate concern.
//!
//! The store is deliberately small: one mutex guards one atomic state
//! transition, the household and worker identity are immutable, and a single
//! injectable validator decides whether a config is supported. Persistence
//! never marks an unsupported config good on its own. Ordering is strict: the
//! disk rename commits first and memory advances only afterwards.
//!
//! # Durability contract
//!
//! A successful `apply` is durable across a **process restart**: the new file
//! is fully written and synced before the atomic rename. The parent-directory
//! sync that makes the rename survive sudden power loss is best effort; its
//! failure is deliberately not returned, because at that point the rename has
//! already replaced the snapshot and memory has advanced with it. After such
//! a failure the on-disk state is the new snapshot (or, after power loss, the
//! old directory entry may still win) — it is never reported as a failure that
//! left the previous snapshot in place. Failures *before* the rename are
//! reported and do leave the previous snapshot intact.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use vantyr_network_policy::store::MAX_NETWORK_EVENT_RETENTION_SECS;
use vantyr_network_policy::{HouseholdId, Policy, PolicyRevision};

/// Bumped only with an explicit migration. A snapshot from another schema is
/// rejected rather than guessed at.
pub const SNAPSHOT_SCHEMA: u32 = 1;
/// Hard read/write bound; a larger snapshot is rejected before it is parsed or
/// written. Config snapshots are small, so 1 MiB is generous.
pub const MAX_SNAPSHOT_BYTES: u64 = 1 << 20;

/// The caller's "can this worker enforce this config?" seam. Persistence calls
/// it both when loading from disk and when accepting a new candidate, so an
/// unsupported config is never promoted to last-known-good by the file layer.
pub trait PolicyValidator {
    fn validate(&self, policy: &Policy) -> Result<(), String>;
}

impl<F> PolicyValidator for F
where
    F: Fn(&Policy) -> Result<(), String>,
{
    fn validate(&self, policy: &Policy) -> Result<(), String> {
        self(policy)
    }
}

/// Exactly the state written by one apply. `highwater` is the highest
/// revision this worker has applied; a candidate must be strictly newer.
/// Every snapshot we write has `highwater == policy.revision`; a mismatch on
/// load is treated as corruption.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LkgSnapshot {
    pub schema: u32,
    pub household_id: HouseholdId,
    pub worker_id: String,
    pub highwater: PolicyRevision,
    pub policy: Policy,
    pub saved_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LkgError {
    WrongHousehold,
    WrongWorker,
    StaleRevision,
    InvalidRevision,
    InvalidRetention,
    SchemaMismatch { found: u32, expected: u32 },
    RevisionMismatch,
    Malformed(String),
    SymlinkRejected,
    NotRegularFile,
    TooLarge { bytes: u64, limit: u64 },
    Unsupported(String),
    ReadFailed(String),
    WriteFailed(String),
}

impl fmt::Display for LkgError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WrongHousehold => write!(f, "snapshot belongs to another household"),
            Self::WrongWorker => write!(f, "snapshot belongs to another worker"),
            Self::StaleRevision => write!(f, "revision is not newer than the last applied one"),
            Self::InvalidRevision => write!(f, "policy revision must be positive"),
            Self::InvalidRetention => write!(f, "event retention is outside the allowed range"),
            Self::SchemaMismatch { found, expected } => {
                write!(f, "snapshot schema {found} != {expected}")
            }
            Self::RevisionMismatch => write!(f, "highwater does not match the applied revision"),
            Self::Malformed(detail) => write!(f, "malformed snapshot: {detail}"),
            Self::SymlinkRejected => write!(f, "snapshot path is a symlink"),
            Self::NotRegularFile => write!(f, "snapshot path is not a regular file"),
            Self::TooLarge { bytes, limit } => {
                write!(f, "snapshot is {bytes} bytes, limit is {limit}")
            }
            Self::Unsupported(detail) => write!(f, "unsupported config: {detail}"),
            Self::ReadFailed(detail) => write!(f, "snapshot read failed: {detail}"),
            Self::WriteFailed(detail) => write!(f, "snapshot write failed: {detail}"),
        }
    }
}

impl std::error::Error for LkgError {}

type IoHook = fn(&Path) -> io::Result<()>;

/// Internal seams for the two file-system steps around the rename. Production
/// uses a no-op before the rename and a best-effort directory fsync after it;
/// tests inject failures to pin down the pre/post-rename distinction.
#[derive(Clone, Copy)]
struct WriteHooks {
    before_rename: IoHook,
    after_rename: IoHook,
}

impl Default for WriteHooks {
    fn default() -> Self {
        Self {
            before_rename: noop_hook,
            after_rename: sync_parent_dir,
        }
    }
}

fn noop_hook(_path: &Path) -> io::Result<()> {
    Ok(())
}

fn sync_parent_dir(path: &Path) -> io::Result<()> {
    File::open(path).and_then(|dir| dir.sync_all())
}

/// A worker-local last-known-good store bound to one household and one worker.
pub struct LkgStore<V> {
    path: PathBuf,
    household_id: HouseholdId,
    worker_id: String,
    validator: V,
    state: Mutex<Option<LkgSnapshot>>,
    hooks: WriteHooks,
}

impl<V: PolicyValidator> LkgStore<V> {
    /// Load and validate any existing snapshot. A missing file is a valid
    /// empty start state; a present-but-invalid file is an error, never an
    /// ignored file.
    pub fn open(
        path: impl Into<PathBuf>,
        household_id: HouseholdId,
        worker_id: impl Into<String>,
        validator: V,
    ) -> Result<Self, LkgError> {
        let path = path.into();
        let worker_id = worker_id.into();
        let loaded = match read_snapshot(&path)? {
            Some(bytes) => Some(validate_snapshot(
                &bytes,
                &household_id,
                &worker_id,
                &validator,
            )?),
            None => None,
        };
        Ok(Self {
            path,
            household_id,
            worker_id,
            validator,
            state: Mutex::new(loaded),
            hooks: WriteHooks::default(),
        })
    }

    /// Apply a strictly newer policy to the local snapshot file. A returned
    /// `Ok` is durable across process restart; a returned `Err` happened before
    /// the rename and left the previous snapshot on disk and in memory. A
    /// best-effort parent-directory sync failure after the rename is not
    /// returned — see the module's durability contract.
    pub fn apply(&self, candidate: Policy, now: DateTime<Utc>) -> Result<(), LkgError> {
        let mut state = self.state.lock().unwrap();
        if candidate.household_id != self.household_id {
            return Err(LkgError::WrongHousehold);
        }
        if let Some(current) = state.as_ref() {
            if candidate.revision <= current.highwater {
                return Err(LkgError::StaleRevision);
            }
        }
        check_policy(&candidate, &self.validator)?;

        let snapshot = LkgSnapshot {
            schema: SNAPSHOT_SCHEMA,
            household_id: self.household_id,
            worker_id: self.worker_id.clone(),
            highwater: candidate.revision,
            policy: candidate,
            saved_at: now,
        };
        let bytes =
            serde_json::to_vec(&snapshot).map_err(|e| LkgError::WriteFailed(e.to_string()))?;
        if bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
            return Err(LkgError::TooLarge {
                bytes: bytes.len() as u64,
                limit: MAX_SNAPSHOT_BYTES,
            });
        }

        write_snapshot_atomic(&self.path, &bytes, self.hooks)?;
        *state = Some(snapshot);
        Ok(())
    }

    /// In-memory last-known-good policy, if any snapshot has been applied.
    pub fn current(&self) -> Option<Policy> {
        self.state
            .lock()
            .unwrap()
            .as_ref()
            .map(|snapshot| snapshot.policy.clone())
    }

    /// Highest applied revision; `0` means no snapshot yet.
    pub fn highwater(&self) -> PolicyRevision {
        self.state
            .lock()
            .unwrap()
            .as_ref()
            .map_or(0, |snapshot| snapshot.highwater)
    }

    /// Full worker-local snapshot for status/display, including schema and worker.
    pub fn snapshot(&self) -> Option<LkgSnapshot> {
        self.state.lock().unwrap().clone()
    }
}

fn check_policy<V: PolicyValidator>(policy: &Policy, validator: &V) -> Result<(), LkgError> {
    if policy.revision == 0 {
        return Err(LkgError::InvalidRevision);
    }
    if policy.event_retention_secs == 0
        || policy.event_retention_secs > MAX_NETWORK_EVENT_RETENTION_SECS
    {
        return Err(LkgError::InvalidRetention);
    }
    validator.validate(policy).map_err(LkgError::Unsupported)
}

fn validate_snapshot<V: PolicyValidator>(
    bytes: &[u8],
    household_id: &HouseholdId,
    worker_id: &str,
    validator: &V,
) -> Result<LkgSnapshot, LkgError> {
    let snapshot: LkgSnapshot =
        serde_json::from_slice(bytes).map_err(|e| LkgError::Malformed(e.to_string()))?;
    if snapshot.schema != SNAPSHOT_SCHEMA {
        return Err(LkgError::SchemaMismatch {
            found: snapshot.schema,
            expected: SNAPSHOT_SCHEMA,
        });
    }
    if snapshot.household_id != *household_id || snapshot.policy.household_id != *household_id {
        return Err(LkgError::WrongHousehold);
    }
    if snapshot.worker_id != worker_id {
        return Err(LkgError::WrongWorker);
    }
    if snapshot.highwater != snapshot.policy.revision {
        return Err(LkgError::RevisionMismatch);
    }
    check_policy(&snapshot.policy, validator)?;
    Ok(snapshot)
}

/// Bounded, symlink-refusing read. Metadata is checked first so a symlink is
/// reported precisely, then the open uses `O_NOFOLLOW` on Unix to avoid a
/// last-moment swap between check and open.
fn read_snapshot(path: &Path) -> Result<Option<Vec<u8>>, LkgError> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(LkgError::ReadFailed(e.to_string())),
    };
    if meta.file_type().is_symlink() {
        return Err(LkgError::SymlinkRejected);
    }
    if !meta.file_type().is_file() {
        return Err(LkgError::NotRegularFile);
    }
    if meta.len() > MAX_SNAPSHOT_BYTES {
        return Err(LkgError::TooLarge {
            bytes: meta.len(),
            limit: MAX_SNAPSHOT_BYTES,
        });
    }

    let file = open_snapshot(path)?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(MAX_SNAPSHOT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| LkgError::ReadFailed(e.to_string()))?;
    if bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
        return Err(LkgError::TooLarge {
            bytes: bytes.len() as u64,
            limit: MAX_SNAPSHOT_BYTES,
        });
    }
    Ok(Some(bytes))
}

#[cfg(unix)]
fn open_snapshot(path: &Path) -> Result<File, LkgError> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| LkgError::ReadFailed(e.to_string()))
}

#[cfg(not(unix))]
fn open_snapshot(path: &Path) -> Result<File, LkgError> {
    OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|e| LkgError::ReadFailed(e.to_string()))
}

/// Same-directory temp file, mode 0600, full write + file sync, then atomic
/// rename. A failure before the rename drops the temp file and leaves the
/// previous snapshot untouched. The parent-directory fsync after the rename is
/// best effort; its error is ignored because the rename already committed.
fn write_snapshot_atomic(path: &Path, bytes: &[u8], hooks: WriteHooks) -> Result<(), LkgError> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temp = tempfile::Builder::new()
        .prefix(".lkg-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|e| LkgError::WriteFailed(e.to_string()))?;
    {
        let file = temp.as_file_mut();
        file.write_all(bytes)
            .map_err(|e| LkgError::WriteFailed(e.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|e| LkgError::WriteFailed(e.to_string()))?;
        }
        file.sync_all()
            .map_err(|e| LkgError::WriteFailed(e.to_string()))?;
    }
    (hooks.before_rename)(path)
        .map_err(|e| LkgError::WriteFailed(format!("before rename: {e}")))?;
    temp.persist(path)
        .map_err(|e| LkgError::WriteFailed(e.to_string()))?;

    // Best effort by contract: once the rename succeeded, an unsynced
    // directory is an uncertainty about power-loss survival, not a failed
    // replacement. Do not turn it into an error while memory still holds the
    // old snapshot.
    let _ = (hooks.after_rename)(parent);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration as ChronoDuration;
    use std::collections::BTreeMap;
    use uuid::Uuid;
    use vantyr_network_policy::{Effect, Rule, RuleMatcher};

    const WORKER: &str = "vantyr-dns";

    fn ts(s: &str) -> DateTime<Utc> {
        chrono::DateTime::parse_from_rfc3339(s)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn household() -> HouseholdId {
        Uuid::new_v4()
    }

    fn rule(id: &str) -> Rule {
        Rule {
            id: id.to_owned(),
            effect: Effect::Deny,
            matcher: RuleMatcher::Any,
            schedule: None,
            reason: "test rule".into(),
        }
    }

    fn policy(household_id: HouseholdId, revision: u64, rule_id: &str) -> Policy {
        Policy {
            household_id,
            revision,
            baseline: vec![rule(rule_id)],
            device_profiles: BTreeMap::new(),
            person_rules: BTreeMap::new(),
            exceptions: Vec::new(),
            default_effect: Effect::Deny,
            timezone: "UTC".into(),
            stale_after_secs: 3600,
            event_retention_secs: 7 * 24 * 3600,
            published_at: ts("2026-11-26T10:00:00Z"),
        }
    }

    fn snapshot(h: HouseholdId, worker: &str, revision: u64) -> LkgSnapshot {
        LkgSnapshot {
            schema: SNAPSHOT_SCHEMA,
            household_id: h,
            worker_id: worker.to_owned(),
            highwater: revision,
            policy: policy(h, revision, "base"),
            saved_at: ts("2026-11-26T10:00:00Z"),
        }
    }

    fn write_raw(path: &Path, bytes: &[u8]) {
        fs::write(path, bytes).unwrap();
    }

    fn write_snapshot(path: &Path, snapshot: &LkgSnapshot) {
        write_raw(path, &serde_json::to_vec(snapshot).unwrap());
    }

    fn accepting() -> impl Fn(&Policy) -> Result<(), String> {
        |_p: &Policy| Ok(())
    }

    fn rejecting_unsupported() -> impl Fn(&Policy) -> Result<(), String> {
        |p: &Policy| {
            if p.baseline.iter().any(|r| r.id == "unsupported") {
                Err("rule not enforceable by this worker".into())
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn empty_directory_is_a_valid_no_snapshot_start() {
        let dir = tempfile::tempdir().unwrap();
        let store = LkgStore::open(
            dir.path().join("lkg.json"),
            household(),
            WORKER,
            accepting(),
        )
        .unwrap();
        assert!(store.current().is_none());
        assert_eq!(store.highwater(), 0);
        assert!(store.snapshot().is_none());
    }

    #[test]
    fn restart_loads_applied_snapshot_after_lost_ack_and_rejects_old_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lkg.json");
        let h = household();
        let now = ts("2026-11-26T10:00:00Z");

        let first = LkgStore::open(path.clone(), h, WORKER, accepting()).unwrap();
        first.apply(policy(h, 1, "base"), now).unwrap();
        assert_eq!(
            first.apply(policy(h, 1, "base"), now),
            Err(LkgError::StaleRevision)
        );
        first
            .apply(policy(h, 2, "new"), now + ChronoDuration::minutes(1))
            .unwrap();
        drop(first); // simulate a worker restart whose ack never reached the controller

        let restarted = LkgStore::open(path.clone(), h, WORKER, accepting()).unwrap();
        let loaded = restarted.snapshot().unwrap();
        assert_eq!(loaded.schema, SNAPSHOT_SCHEMA);
        assert_eq!(loaded.worker_id, WORKER);
        assert_eq!(loaded.highwater, 2);
        assert_eq!(
            loaded.policy.revision, 2,
            "applied config survives lost ack"
        );
        assert_eq!(loaded.policy.baseline[0].id, "new");
        assert_eq!(
            restarted.apply(policy(h, 2, "new"), now),
            Err(LkgError::StaleRevision)
        );
        assert_eq!(
            restarted.apply(policy(h, 1, "base"), now),
            Err(LkgError::StaleRevision),
            "an old revision cannot replace the applied one"
        );

        // A rollback is a NEW, higher revision carrying prior content.
        restarted
            .apply(policy(h, 3, "base"), now + ChronoDuration::minutes(2))
            .unwrap();
        drop(restarted);

        let rolled_back = LkgStore::open(path, h, WORKER, accepting()).unwrap();
        assert_eq!(rolled_back.highwater(), 3);
        assert_eq!(rolled_back.current().unwrap().revision, 3);
        assert_eq!(rolled_back.current().unwrap().baseline[0].id, "base");
    }

    #[test]
    fn validator_decides_supported_config_and_never_regresses_on_failure() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lkg.json");
        let h = household();
        let now = ts("2026-11-26T10:00:00Z");
        let store = LkgStore::open(path.clone(), h, WORKER, rejecting_unsupported()).unwrap();

        assert_eq!(
            store.apply(policy(h, 1, "unsupported"), now),
            Err(LkgError::Unsupported(
                "rule not enforceable by this worker".into()
            ))
        );
        assert!(!path.exists(), "unsupported config must not reach disk");

        store.apply(policy(h, 1, "base"), now).unwrap();
        let committed = fs::read(&path).unwrap();
        assert_eq!(
            store.apply(policy(h, 2, "unsupported"), now),
            Err(LkgError::Unsupported(
                "rule not enforceable by this worker".into()
            ))
        );
        assert_eq!(fs::read(&path).unwrap(), committed, "disk did not change");
        assert_eq!(
            store.current().unwrap().revision,
            1,
            "memory did not change"
        );
    }

    #[test]
    fn unsupported_snapshot_on_disk_is_rejected_at_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lkg.json");
        let h = household();
        let mut bad = snapshot(h, WORKER, 4);
        bad.policy.baseline = vec![rule("unsupported")];
        write_snapshot(&path, &bad);

        assert_eq!(
            LkgStore::open(path, h, WORKER, rejecting_unsupported()).err(),
            Some(LkgError::Unsupported(
                "rule not enforceable by this worker".into()
            ))
        );
    }

    #[test]
    fn foreign_household_worker_schema_revision_and_retention_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let h = household();
        let now = ts("2026-11-26T10:00:00Z");
        let mut cases = Vec::new();

        let mut foreign = snapshot(household(), WORKER, 1);
        cases.push((foreign.clone(), LkgError::WrongHousehold));
        foreign.policy.household_id = household();
        cases.push((foreign, LkgError::WrongHousehold));

        cases.push((snapshot(h, "vantyr-proxy", 1), LkgError::WrongWorker));

        let mut wrong_schema = snapshot(h, WORKER, 1);
        wrong_schema.schema = 99;
        cases.push((
            wrong_schema,
            LkgError::SchemaMismatch {
                found: 99,
                expected: 1,
            },
        ));

        let mut wrong_highwater = snapshot(h, WORKER, 1);
        wrong_highwater.highwater = 2;
        cases.push((wrong_highwater, LkgError::RevisionMismatch));

        let mut zero_revision = snapshot(h, WORKER, 1);
        zero_revision.policy.revision = 0;
        zero_revision.highwater = 0;
        cases.push((zero_revision, LkgError::InvalidRevision));

        let mut bad_retention = snapshot(h, WORKER, 1);
        bad_retention.policy.event_retention_secs = 0;
        cases.push((bad_retention, LkgError::InvalidRetention));

        for (index, (snap, expected)) in cases.into_iter().enumerate() {
            let path = dir.path().join(format!("case-{index}.json"));
            write_snapshot(&path, &snap);
            let result = LkgStore::open(path, h, WORKER, accepting());
            assert_eq!(result.err(), Some(expected), "case {index}");
        }

        // The same checks apply to a candidate at apply time.
        let store = LkgStore::open(dir.path().join("apply.json"), h, WORKER, accepting()).unwrap();
        let mut foreign_candidate = policy(h, 1, "base");
        foreign_candidate.household_id = household();
        assert_eq!(
            store.apply(foreign_candidate, now),
            Err(LkgError::WrongHousehold)
        );
        let mut bad_retention = policy(h, 1, "base");
        bad_retention.event_retention_secs = 0;
        assert_eq!(
            store.apply(bad_retention, now),
            Err(LkgError::InvalidRetention)
        );
        assert!(store.current().is_none());
    }

    #[test]
    fn malformed_truncated_and_oversize_snapshots_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let h = household();
        let valid = serde_json::to_vec(&snapshot(h, WORKER, 1)).unwrap();

        let malformed = dir.path().join("malformed.json");
        write_raw(&malformed, b"{\"schema\":");
        assert!(matches!(
            LkgStore::open(&malformed, h, WORKER, accepting()),
            Err(LkgError::Malformed(_))
        ));

        let truncated = dir.path().join("truncated.json");
        write_raw(&truncated, &valid[..valid.len() / 2]);
        assert!(matches!(
            LkgStore::open(&truncated, h, WORKER, accepting()),
            Err(LkgError::Malformed(_))
        ));

        let oversize = dir.path().join("oversize.json");
        write_raw(&oversize, &vec![b'a'; MAX_SNAPSHOT_BYTES as usize + 1]);
        assert_eq!(
            LkgStore::open(&oversize, h, WORKER, accepting()).err(),
            Some(LkgError::TooLarge {
                bytes: MAX_SNAPSHOT_BYTES + 1,
                limit: MAX_SNAPSHOT_BYTES,
            })
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_snapshot_is_rejected() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let h = household();
        let real = dir.path().join("real.json");
        write_snapshot(&real, &snapshot(h, WORKER, 1));
        let linked = dir.path().join("lkg.json");
        symlink(&real, &linked).unwrap();

        assert_eq!(
            LkgStore::open(linked, h, WORKER, accepting()).err(),
            Some(LkgError::SymlinkRejected)
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_failure_keeps_the_previous_snapshot() {
        use std::os::unix::fs::PermissionsExt;

        // chmod does not restrict root, so skip where it cannot inject failure.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lkg.json");
        let h = household();
        let now = ts("2026-11-26T10:00:00Z");
        let store = LkgStore::open(path.clone(), h, WORKER, accepting()).unwrap();
        store.apply(policy(h, 1, "base"), now).unwrap();
        let committed = fs::read(&path).unwrap();

        let mut read_only = fs::metadata(dir.path()).unwrap().permissions();
        read_only.set_mode(0o500);
        fs::set_permissions(dir.path(), read_only).unwrap();
        let result = store.apply(policy(h, 2, "new"), now);
        let mut writable = fs::metadata(dir.path()).unwrap().permissions();
        writable.set_mode(0o700);
        fs::set_permissions(dir.path(), writable).unwrap();

        assert!(
            matches!(result, Err(LkgError::WriteFailed(_))),
            "{result:?}"
        );
        assert_eq!(
            fs::read(&path).unwrap(),
            committed,
            "previous file retained"
        );
        assert_eq!(store.current().unwrap().revision, 1, "memory retained");
        drop(store);

        let reopened = LkgStore::open(path, h, WORKER, accepting()).unwrap();
        assert_eq!(reopened.current().unwrap().revision, 1);
        assert_eq!(reopened.highwater(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lkg.json");
        let h = household();
        let store = LkgStore::open(path.clone(), h, WORKER, accepting()).unwrap();
        store
            .apply(policy(h, 1, "base"), ts("2026-11-26T10:00:00Z"))
            .unwrap();
        let mode = fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "state may carry secrets");
    }

    #[test]
    fn oversize_apply_is_rejected_without_replacing_file_or_memory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lkg.json");
        let h = household();
        let now = ts("2026-11-26T10:00:00Z");
        let mut huge = policy(h, 2, "too-big");
        huge.baseline[0].reason = "x".repeat(MAX_SNAPSHOT_BYTES as usize + 1);
        let probe = LkgSnapshot {
            schema: SNAPSHOT_SCHEMA,
            household_id: h,
            worker_id: WORKER.to_owned(),
            highwater: 2,
            policy: huge.clone(),
            saved_at: now,
        };
        let probe_bytes = serde_json::to_vec(&probe).unwrap().len() as u64;
        assert!(probe_bytes > MAX_SNAPSHOT_BYTES);
        let expected = LkgError::TooLarge {
            bytes: probe_bytes,
            limit: MAX_SNAPSHOT_BYTES,
        };

        let fresh = LkgStore::open(path.clone(), h, WORKER, accepting()).unwrap();
        assert_eq!(fresh.apply(huge.clone(), now), Err(expected.clone()));
        assert!(!path.exists(), "no file created for an oversize candidate");
        assert!(fresh.current().is_none());

        let store = LkgStore::open(path.clone(), h, WORKER, accepting()).unwrap();
        store.apply(policy(h, 1, "base"), now).unwrap();
        let committed = fs::read(&path).unwrap();
        assert_eq!(store.apply(huge, now), Err(expected));
        assert_eq!(fs::read(&path).unwrap(), committed, "file unchanged");
        assert_eq!(store.current().unwrap().revision, 1, "memory unchanged");
    }

    #[test]
    fn injected_pre_rename_failure_retains_old_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lkg.json");
        let h = household();
        let now = ts("2026-11-26T10:00:00Z");
        let mut store = LkgStore::open(path.clone(), h, WORKER, accepting()).unwrap();
        store.apply(policy(h, 1, "base"), now).unwrap();
        let committed = fs::read(&path).unwrap();

        store.hooks.before_rename = |_| Err(io::Error::other("injected before rename"));
        let result = store.apply(policy(h, 2, "new"), now);
        assert!(
            matches!(&result, Err(LkgError::WriteFailed(detail)) if detail.contains("before rename")),
            "{result:?}"
        );
        assert_eq!(fs::read(&path).unwrap(), committed, "old file retained");
        assert_eq!(store.current().unwrap().revision, 1, "old memory retained");
    }

    #[test]
    fn injected_post_rename_sync_failure_keeps_success_contract() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lkg.json");
        let h = household();
        let now = ts("2026-11-26T10:00:00Z");
        let mut store = LkgStore::open(path.clone(), h, WORKER, accepting()).unwrap();
        store.apply(policy(h, 1, "base"), now).unwrap();

        store.hooks.after_rename = |_| Err(io::Error::other("injected directory fsync"));
        // The rename already committed: no error is returned, and the in-memory
        // last-known-good advances with the file. Power-loss survival of the
        // directory entry is the only uncertainty.
        store.apply(policy(h, 2, "new"), now).unwrap();
        let on_disk: LkgSnapshot = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            on_disk.highwater, 2,
            "new file committed before the sync hook"
        );
        assert_eq!(store.current().unwrap().revision, 2);
        drop(store);

        let reopened = LkgStore::open(path, h, WORKER, accepting()).unwrap();
        assert_eq!(reopened.current().unwrap().revision, 2);
    }
}
