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
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use vantyr_network_policy::store::MAX_NETWORK_EVENT_RETENTION_SECS;
use vantyr_network_policy::{HouseholdId, Policy, PolicyRevision};

/// Bumped only with an explicit migration. A snapshot from another schema is
/// rejected rather than guessed at.
pub const SNAPSHOT_SCHEMA: u32 = 1;
/// Default hard read/write bound; a larger snapshot is rejected before it is
/// parsed or written. Policy-only and small config+policy snapshots are small,
/// so 1 MiB is generous. A store carrying a larger *typed* payload (for
/// example bounded filter material) can raise this via
/// [`TypedLkgStore::open_with_limit`] without changing the default or any
/// other store.
pub const MAX_SNAPSHOT_BYTES: u64 = 1 << 20;

/// One typed payload that can be kept as last-known-good. The payload may be a
/// bare `Policy` (the original worker contract) or a complete config+policy
/// bundle; the store itself is format-agnostic and never interprets fields.
pub trait Persistable: Clone + Serialize + DeserializeOwned {
    fn revision(&self) -> PolicyRevision;
    fn household_id(&self) -> HouseholdId;
    /// Payload-specific shape checks shared by disk loads and new candidates.
    /// A deserialized payload must satisfy these checks exactly as written;
    /// missing fields are rejected, never repaired.
    fn check(&self) -> Result<(), LkgError>;
}

/// The caller's "can this worker enforce this payload?" seam. Persistence calls
/// it both when loading from disk and when accepting a new candidate, so an
/// unsupported payload is never promoted to last-known-good by the file layer.
pub trait Validator<T> {
    fn validate(&self, payload: &T) -> Result<(), String>;
}

/// Shape checks that every `Policy` payload must pass, regardless of whether
/// it is stored alone or inside a larger bundle.
pub fn check_policy_shape(policy: &Policy) -> Result<(), LkgError> {
    if policy.revision == 0 {
        return Err(LkgError::InvalidRevision);
    }
    if policy.event_retention_secs == 0
        || policy.event_retention_secs > MAX_NETWORK_EVENT_RETENTION_SECS
    {
        return Err(LkgError::InvalidRetention);
    }
    Ok(())
}

impl Persistable for Policy {
    fn revision(&self) -> PolicyRevision {
        self.revision
    }
    fn household_id(&self) -> HouseholdId {
        self.household_id
    }
    fn check(&self) -> Result<(), LkgError> {
        check_policy_shape(self)
    }
}

/// Exactly the state written by one apply. `highwater` is the highest
/// revision this worker has applied; a candidate must be strictly newer.
/// Every snapshot we write has `highwater == payload.revision()`; a mismatch on
/// load is treated as corruption. The field name `policy` is retained in the
/// on-disk shape; for a generic store it holds that store's typed payload.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TypedSnapshot<T = Policy> {
    pub schema: u32,
    pub household_id: HouseholdId,
    pub worker_id: String,
    pub highwater: PolicyRevision,
    pub policy: T,
    pub saved_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LkgError {
    WrongHousehold,
    WrongWorker,
    StaleRevision,
    Missing,
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
            Self::Missing => write!(f, "no snapshot exists"),
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

/// Type of the injectable file-system seam. Production hooks are a no-op before
/// the rename and a best-effort directory sync after it; tests inject failures
/// to pin down the pre/post-rename distinction.
pub type IoHook = fn(&Path) -> io::Result<()>;

/// Seams for the two file-system steps around the rename. Exposed so a worker
/// can inject a failure in tests without weakening the production contract.
#[derive(Clone, Copy, Debug)]
pub struct WriteHooks {
    pub before_rename: IoHook,
    pub after_rename: IoHook,
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

/// A worker-local last-known-good store for one typed payload, bound to one
/// immutable household and one immutable worker identity. The same atomic file
/// protocol is shared by all payload types: there is never a second file that
/// could disagree with the first.
pub struct TypedLkgStore<T: Persistable, V> {
    path: PathBuf,
    household_id: HouseholdId,
    worker_id: String,
    validator: V,
    state: Mutex<Option<TypedSnapshot<T>>>,
    hooks: WriteHooks,
    /// Per-store serialization ceiling. Defaults to [`MAX_SNAPSHOT_BYTES`];
    /// a worker with a genuinely larger typed payload can opt in explicitly.
    max_bytes: u64,
}

impl<T: Persistable, V: Validator<T>> TypedLkgStore<T, V> {
    /// Load and validate any existing snapshot. A missing file is a valid
    /// empty start state; a present-but-invalid file is an error, never an
    /// ignored file.
    pub fn open(
        path: impl Into<PathBuf>,
        household_id: HouseholdId,
        worker_id: impl Into<String>,
        validator: V,
    ) -> Result<Self, LkgError> {
        Self::open_with_limit(path, household_id, worker_id, validator, MAX_SNAPSHOT_BYTES)
    }

    /// Same protocol as [`Self::open`] with an explicit per-store byte ceiling.
    /// The limit is applied to the on-disk file *before* it is allocated and to
    /// the serialized candidate before it is written. A payload that does not
    /// need more than the default should keep using [`Self::open`].
    pub fn open_with_limit(
        path: impl Into<PathBuf>,
        household_id: HouseholdId,
        worker_id: impl Into<String>,
        validator: V,
        max_bytes: u64,
    ) -> Result<Self, LkgError> {
        if max_bytes == 0 {
            return Err(LkgError::Malformed("max_bytes must be positive".into()));
        }
        let path = path.into();
        let worker_id = worker_id.into();
        let loaded = match read_snapshot(&path, max_bytes)? {
            Some(bytes) => Some(validate_snapshot(
                &bytes,
                Some(&household_id),
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
            max_bytes,
        })
    }

    /// Open a store whose household identity comes from the snapshot itself.
    /// Used on worker restart: the local durable file is authoritative for the
    /// instance identity, and its worker id is still checked against the flag.
    /// A missing file is reported as [`LkgError::Missing`], never as an empty
    /// store that a caller could accidentally bootstrap over an existing file.
    pub fn open_from_snapshot(
        path: impl Into<PathBuf>,
        worker_id: impl Into<String>,
        validator: V,
    ) -> Result<Self, LkgError> {
        Self::open_from_snapshot_with_limit(path, worker_id, validator, MAX_SNAPSHOT_BYTES)
    }

    /// Restart variant of [`Self::open_with_limit`]: household identity still
    /// comes from the one durable file, but the read is bounded by the caller's
    /// payload size rather than the crate default.
    pub fn open_from_snapshot_with_limit(
        path: impl Into<PathBuf>,
        worker_id: impl Into<String>,
        validator: V,
        max_bytes: u64,
    ) -> Result<Self, LkgError> {
        if max_bytes == 0 {
            return Err(LkgError::Malformed("max_bytes must be positive".into()));
        }
        let path = path.into();
        let worker_id = worker_id.into();
        let bytes = read_snapshot(&path, max_bytes)?.ok_or(LkgError::Missing)?;
        let loaded = validate_snapshot(&bytes, None, &worker_id, &validator)?;
        let household_id = loaded.household_id;
        Ok(Self {
            path,
            household_id,
            worker_id,
            validator,
            state: Mutex::new(Some(loaded)),
            hooks: WriteHooks::default(),
            max_bytes,
        })
    }

    /// Replace the injectable write seams (test-only hook contract).
    pub fn with_hooks(mut self, hooks: WriteHooks) -> Self {
        self.hooks = hooks;
        self
    }

    /// Apply a strictly newer payload to the local snapshot file. A returned
    /// `Ok` is durable across process restart; a returned `Err` happened before
    /// the rename and left the previous snapshot on disk and in memory. A
    /// best-effort parent-directory sync failure after the rename is not
    /// returned — see the module's durability contract.
    pub fn apply(&self, candidate: T, now: DateTime<Utc>) -> Result<(), LkgError> {
        check_payload(&candidate, &self.validator)?;
        let mut state = self.state.lock().unwrap();
        if candidate.household_id() != self.household_id {
            return Err(LkgError::WrongHousehold);
        }
        if let Some(current) = state.as_ref() {
            if candidate.revision() <= current.highwater {
                return Err(LkgError::StaleRevision);
            }
        }
        let snapshot = TypedSnapshot {
            schema: SNAPSHOT_SCHEMA,
            household_id: self.household_id,
            worker_id: self.worker_id.clone(),
            highwater: candidate.revision(),
            policy: candidate,
            saved_at: now,
        };
        let bytes =
            serde_json::to_vec(&snapshot).map_err(|e| LkgError::WriteFailed(e.to_string()))?;
        if bytes.len() as u64 > self.max_bytes {
            return Err(LkgError::TooLarge {
                bytes: bytes.len() as u64,
                limit: self.max_bytes,
            });
        }

        write_snapshot_atomic(&self.path, &bytes, self.hooks)?;
        *state = Some(snapshot);
        Ok(())
    }

    /// In-memory last-known-good payload, if any snapshot has been applied.
    pub fn current(&self) -> Option<T> {
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
    pub fn snapshot(&self) -> Option<TypedSnapshot<T>> {
        self.state.lock().unwrap().clone()
    }

    pub fn household_id(&self) -> HouseholdId {
        self.household_id
    }

    pub fn worker_id(&self) -> &str {
        &self.worker_id
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn check_payload<T: Persistable, V: Validator<T>>(
    payload: &T,
    validator: &V,
) -> Result<(), LkgError> {
    payload.check()?;
    validator.validate(payload).map_err(LkgError::Unsupported)
}

fn validate_snapshot<T: Persistable, V: Validator<T>>(
    bytes: &[u8],
    household_id: Option<&HouseholdId>,
    worker_id: &str,
    validator: &V,
) -> Result<TypedSnapshot<T>, LkgError> {
    let snapshot: TypedSnapshot<T> =
        serde_json::from_slice(bytes).map_err(|e| LkgError::Malformed(e.to_string()))?;
    if snapshot.schema != SNAPSHOT_SCHEMA {
        return Err(LkgError::SchemaMismatch {
            found: snapshot.schema,
            expected: SNAPSHOT_SCHEMA,
        });
    }
    // Deserialized payloads have not passed their shape checks yet. Accessors
    // may rely on those invariants (for example a validated UUID string).
    check_payload(&snapshot.policy, validator)?;
    match household_id {
        Some(expected)
            if snapshot.household_id != *expected
                || snapshot.policy.household_id() != *expected =>
        {
            return Err(LkgError::WrongHousehold);
        }
        None if snapshot.household_id != snapshot.policy.household_id() => {
            return Err(LkgError::WrongHousehold);
        }
        _ => {}
    }
    if snapshot.worker_id != worker_id {
        return Err(LkgError::WrongWorker);
    }
    if snapshot.highwater != snapshot.policy.revision() {
        return Err(LkgError::RevisionMismatch);
    }
    Ok(snapshot)
}

/// Bounded, symlink-refusing read. Metadata is checked first so a symlink is
/// reported precisely, then the open uses `O_NOFOLLOW` on Unix to avoid a
/// last-moment swap between check and open.
fn read_snapshot(path: &Path, max_bytes: u64) -> Result<Option<Vec<u8>>, LkgError> {
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
    // Check the metadata bound before allocating, so an oversized file is
    // rejected without ever holding it in memory.
    if meta.len() > max_bytes {
        return Err(LkgError::TooLarge {
            bytes: meta.len(),
            limit: max_bytes,
        });
    }

    let file = open_snapshot(path)?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| LkgError::ReadFailed(e.to_string()))?;
    if bytes.len() as u64 > max_bytes {
        return Err(LkgError::TooLarge {
            bytes: bytes.len() as u64,
            limit: max_bytes,
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
/// One-shot, owner-private (mode 0600) atomic replacement in the file's own
/// directory. Reusable by explicit offline tools that must not install a
/// runtime compatibility reader: the caller owns all validation, backup and
/// policy decisions around this write.
pub fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), LkgError> {
    write_snapshot_atomic(path, bytes, WriteHooks::default())
}

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

    fn snapshot(h: HouseholdId, worker: &str, revision: u64) -> TypedSnapshot<Policy> {
        TypedSnapshot {
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

    fn write_snapshot(path: &Path, snapshot: &TypedSnapshot<Policy>) {
        write_raw(path, &serde_json::to_vec(snapshot).unwrap());
    }

    #[derive(Clone, Copy)]
    struct AcceptAll;

    impl Validator<Policy> for AcceptAll {
        fn validate(&self, _policy: &Policy) -> Result<(), String> {
            Ok(())
        }
    }

    #[derive(Clone, Copy)]
    struct RejectUnsupported;

    impl Validator<Policy> for RejectUnsupported {
        fn validate(&self, policy: &Policy) -> Result<(), String> {
            if policy.baseline.iter().any(|r| r.id == "unsupported") {
                Err("rule not enforceable by this worker".into())
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn empty_directory_is_a_valid_no_snapshot_start() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            TypedLkgStore::open(dir.path().join("lkg.json"), household(), WORKER, AcceptAll)
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

        let first = TypedLkgStore::open(path.clone(), h, WORKER, AcceptAll).unwrap();
        first.apply(policy(h, 1, "base"), now).unwrap();
        assert_eq!(
            first.apply(policy(h, 1, "base"), now),
            Err(LkgError::StaleRevision)
        );
        first
            .apply(policy(h, 2, "new"), now + ChronoDuration::minutes(1))
            .unwrap();
        drop(first); // simulate a worker restart whose ack never reached the controller

        let restarted = TypedLkgStore::open(path.clone(), h, WORKER, AcceptAll).unwrap();
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

        let rolled_back = TypedLkgStore::open(path, h, WORKER, AcceptAll).unwrap();
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
        let store = TypedLkgStore::open(path.clone(), h, WORKER, RejectUnsupported).unwrap();

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
            TypedLkgStore::open(path, h, WORKER, RejectUnsupported).err(),
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
            let result = TypedLkgStore::open(path, h, WORKER, AcceptAll);
            assert_eq!(result.err(), Some(expected), "case {index}");
        }

        // The same checks apply to a candidate at apply time.
        let store =
            TypedLkgStore::open(dir.path().join("apply.json"), h, WORKER, AcceptAll).unwrap();
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
            TypedLkgStore::open(&malformed, h, WORKER, AcceptAll),
            Err(LkgError::Malformed(_))
        ));

        let truncated = dir.path().join("truncated.json");
        write_raw(&truncated, &valid[..valid.len() / 2]);
        assert!(matches!(
            TypedLkgStore::open(&truncated, h, WORKER, AcceptAll),
            Err(LkgError::Malformed(_))
        ));

        let oversize = dir.path().join("oversize.json");
        write_raw(&oversize, &vec![b'a'; MAX_SNAPSHOT_BYTES as usize + 1]);
        assert_eq!(
            TypedLkgStore::open(&oversize, h, WORKER, AcceptAll).err(),
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
            TypedLkgStore::open(linked, h, WORKER, AcceptAll).err(),
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
        let store = TypedLkgStore::open(path.clone(), h, WORKER, AcceptAll).unwrap();
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

        let reopened = TypedLkgStore::open(path, h, WORKER, AcceptAll).unwrap();
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
        let store = TypedLkgStore::open(path.clone(), h, WORKER, AcceptAll).unwrap();
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
        let probe = TypedSnapshot {
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

        let fresh = TypedLkgStore::open(path.clone(), h, WORKER, AcceptAll).unwrap();
        assert_eq!(fresh.apply(huge.clone(), now), Err(expected.clone()));
        assert!(!path.exists(), "no file created for an oversize candidate");
        assert!(fresh.current().is_none());

        let store = TypedLkgStore::open(path.clone(), h, WORKER, AcceptAll).unwrap();
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
        let mut store = TypedLkgStore::open(path.clone(), h, WORKER, AcceptAll).unwrap();
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
        let mut store = TypedLkgStore::open(path.clone(), h, WORKER, AcceptAll).unwrap();
        store.apply(policy(h, 1, "base"), now).unwrap();

        store.hooks.after_rename = |_| Err(io::Error::other("injected directory fsync"));
        // The rename already committed: no error is returned, and the in-memory
        // last-known-good advances with the file. Power-loss survival of the
        // directory entry is the only uncertainty.
        store.apply(policy(h, 2, "new"), now).unwrap();
        let on_disk: TypedSnapshot<Policy> =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            on_disk.highwater, 2,
            "new file committed before the sync hook"
        );
        assert_eq!(store.current().unwrap().revision, 2);
        drop(store);

        let reopened = TypedLkgStore::open(path, h, WORKER, AcceptAll).unwrap();
        assert_eq!(reopened.current().unwrap().revision, 2);
    }

    #[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
    struct MiniPayload {
        owner: HouseholdId,
        revision: PolicyRevision,
        note: String,
    }

    impl Persistable for MiniPayload {
        fn revision(&self) -> PolicyRevision {
            self.revision
        }
        fn household_id(&self) -> HouseholdId {
            self.owner
        }
        fn check(&self) -> Result<(), LkgError> {
            if self.revision == 0 || self.note.is_empty() {
                Err(LkgError::Malformed("bad mini payload".into()))
            } else {
                Ok(())
            }
        }
    }

    #[derive(Clone, Copy)]
    struct MiniValidator;

    impl Validator<MiniPayload> for MiniValidator {
        fn validate(&self, payload: &MiniPayload) -> Result<(), String> {
            if payload.note == "unsupported" {
                Err("mini payload not enforceable".into())
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn typed_store_reuses_one_protocol_for_a_non_policy_payload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bundle.json");
        let h = household();
        let now = ts("2026-11-26T10:00:00Z");
        let payload = |revision, note: &str| MiniPayload {
            owner: h,
            revision,
            note: note.to_owned(),
        };

        let store = TypedLkgStore::open(path.clone(), h, WORKER, MiniValidator).unwrap();
        assert!(store.current().is_none());
        store.apply(payload(1, "base"), now).unwrap();
        assert_eq!(
            store.apply(payload(1, "same"), now),
            Err(LkgError::StaleRevision)
        );
        assert_eq!(
            store.apply(payload(2, "unsupported"), now),
            Err(LkgError::Unsupported("mini payload not enforceable".into()))
        );
        store.apply(payload(3, "next"), now).unwrap();
        drop(store);

        // Restart takes the household identity from the single file and still
        // checks the worker id and every payload rule.
        let reopened = TypedLkgStore::open_from_snapshot(&path, WORKER, MiniValidator).unwrap();
        assert_eq!(reopened.household_id(), h);
        assert_eq!(reopened.highwater(), 3);
        assert_eq!(reopened.current().unwrap().note, "next");
        assert_eq!(
            TypedLkgStore::open_from_snapshot(&path, "other-worker", MiniValidator).err(),
            Some(LkgError::WrongWorker)
        );
        assert_eq!(
            fs::read_dir(dir.path()).unwrap().count(),
            1,
            "one file for one typed bundle"
        );
    }

    #[test]
    fn per_store_limit_raises_the_ceiling_without_changing_the_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("larger.json");
        let h = household();
        let now = ts("2026-11-26T10:00:00Z");
        let mut bigger = policy(h, 1, "base");
        bigger.baseline[0].reason = "x".repeat(MAX_SNAPSHOT_BYTES as usize + 1);

        // The default store still rejects the oversized candidate.
        let fresh = TypedLkgStore::open(path.clone(), h, WORKER, AcceptAll).unwrap();
        assert!(matches!(
            fresh.apply(bigger.clone(), now),
            Err(LkgError::TooLarge { .. })
        ));
        assert!(!path.exists());

        // An explicitly opted-in store accepts the same typed payload...
        let raised = TypedLkgStore::open_with_limit(
            path.clone(),
            h,
            WORKER,
            AcceptAll,
            MAX_SNAPSHOT_BYTES * 2,
        )
        .unwrap();
        raised.apply(bigger, now).unwrap();
        let on_disk = fs::read(&path).unwrap().len() as u64;
        assert!(on_disk > MAX_SNAPSHOT_BYTES);
        assert!(on_disk <= MAX_SNAPSHOT_BYTES * 2);
        drop(raised);

        // ...and a restart reads it only when the same raised limit is given.
        assert!(matches!(
            TypedLkgStore::open_from_snapshot(&path, WORKER, AcceptAll),
            Err(LkgError::TooLarge { .. })
        ));
        let reopened = TypedLkgStore::open_from_snapshot_with_limit(
            &path,
            WORKER,
            AcceptAll,
            MAX_SNAPSHOT_BYTES * 2,
        )
        .unwrap();
        assert_eq!(reopened.highwater(), 1);
    }
}
