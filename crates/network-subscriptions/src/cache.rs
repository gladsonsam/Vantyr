//! One atomic snapshot file per subscription. Metadata, validated bytes and
//! digest live in the same JSON document, so there is no "content file vs
//! metadata file" pair that could disagree. The rename is the single commit
//! point: content is fully written (and synced) before the file becomes
//! visible, and a failed write leaves both the previous file and memory alone.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::{validate_id, Limits};
use crate::error::Error;
use crate::url::ValidatedUrl;

/// Bumped only with an explicit migration. A foreign schema is rejected.
pub const SNAPSHOT_SCHEMA: u32 = 1;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ListSnapshot {
    pub schema: u32,
    pub source_id: String,
    /// Canonical URL identity of this list. A cached entry for a different
    /// URL is rejected, never silently reused.
    pub url: String,
    pub revision: u64,
    pub validator_version: u32,
    /// Validated content is stored before the metadata fields below.
    pub bytes_b64: String,
    pub sha256: String,
    pub rule_count: u64,
    pub checked_at: DateTime<Utc>,
    pub fetched_at: DateTime<Utc>,
    /// Timestamp published by the source (Last-Modified), never synthesized
    /// and never refreshed on a 304.
    pub content_updated_at: Option<DateTime<Utc>>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

impl ListSnapshot {
    pub fn bytes(&self) -> Result<Vec<u8>, Error> {
        BASE64
            .decode(&self.bytes_b64)
            .map_err(|e| Error::Cache(self.source_id.clone(), format!("bad base64: {e}")))
    }

    /// Decoded content length, after cache/base64 validation.
    pub fn content_len(&self) -> usize {
        self.bytes_b64.len() / 4 * 3
            - self
                .bytes_b64
                .bytes()
                .rev()
                .take_while(|b| *b == b'=')
                .count()
    }

    pub fn content_version(&self) -> &str {
        &self.sha256
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest.iter() {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

pub fn snapshot_path(root: &Path, id: &str) -> Result<PathBuf, Error> {
    validate_id(id)?;
    Ok(root.join(format!("{id}.json")))
}

/// Injectable seams around the rename. Production uses a no-op before the
/// rename and a best-effort directory sync after it. Tests inject failures to
/// pin down the pre/post-rename distinction.
#[derive(Clone, Copy, Debug)]
pub struct WriteHooks {
    pub before_rename: fn(&Path) -> io::Result<()>,
    pub after_rename: fn(&Path) -> io::Result<()>,
}

impl Default for WriteHooks {
    fn default() -> Self {
        Self {
            before_rename: |_| Ok(()),
            after_rename: sync_parent_dir,
        }
    }
}

fn sync_parent_dir(path: &Path) -> io::Result<()> {
    File::open(path).and_then(|f| f.sync_all())
}

/// Bounded, symlink-refusing read. Size is checked from metadata before any
/// allocation, then the read itself is capped.
pub fn read_snapshot(
    root: &Path,
    id: &str,
    expected_url: &ValidatedUrl,
    limits: &Limits,
) -> Result<Option<ListSnapshot>, Error> {
    let path = snapshot_path(root, id)?;
    let meta = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(Error::Cache(id.into(), e.to_string())),
    };
    if meta.file_type().is_symlink() {
        return Err(Error::UnsafeCachePath(path.clone()));
    }
    if !meta.file_type().is_file() {
        return Err(Error::Cache(
            id.into(),
            "cache entry is not a regular file".into(),
        ));
    }
    if meta.len() > limits.max_snapshot_bytes {
        return Err(Error::Cache(
            id.into(),
            format!(
                "cache entry is {} bytes, limit {}",
                meta.len(),
                limits.max_snapshot_bytes
            ),
        ));
    }
    let file = open_snapshot(&path)?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(limits.max_snapshot_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| Error::Cache(id.into(), e.to_string()))?;
    if bytes.len() as u64 > limits.max_snapshot_bytes {
        return Err(Error::Cache(
            id.into(),
            "cache entry grew during read".into(),
        ));
    }
    let snapshot: ListSnapshot = serde_json::from_slice(&bytes)
        .map_err(|e| Error::CacheMalformed(id.into(), e.to_string()))?;
    validate_snapshot(&snapshot, id, expected_url, limits)?;
    Ok(Some(snapshot))
}

fn validate_snapshot(
    snapshot: &ListSnapshot,
    id: &str,
    expected_url: &ValidatedUrl,
    limits: &Limits,
) -> Result<(), Error> {
    if snapshot.schema != SNAPSHOT_SCHEMA {
        return Err(Error::CacheMalformed(
            id.into(),
            format!("schema {} != {SNAPSHOT_SCHEMA}", snapshot.schema),
        ));
    }
    if snapshot.source_id != id {
        return Err(Error::Cache(id.into(), "source id mismatch".into()));
    }
    if snapshot.url != expected_url.as_str() {
        return Err(Error::CacheUrlMismatch(id.into()));
    }
    if snapshot.revision == 0 {
        return Err(Error::CacheMalformed(id.into(), "revision is zero".into()));
    }
    let bytes = snapshot.bytes()?;
    if bytes.len() as u64 > limits.max_candidate_bytes {
        return Err(Error::Cache(
            id.into(),
            "cached bytes exceed the candidate byte limit".into(),
        ));
    }
    if snapshot.sha256 != sha256_hex(&bytes) {
        return Err(Error::CacheMalformed(id.into(), "digest mismatch".into()));
    }
    Ok(())
}

#[cfg(unix)]
fn open_snapshot(path: &Path) -> Result<File, Error> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| Error::Cache(path.display().to_string(), e.to_string()))
}

#[cfg(not(unix))]
fn open_snapshot(path: &Path) -> Result<File, Error> {
    OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|e| Error::Cache(path.display().to_string(), e.to_string()))
}

fn check_parent(root: &Path) -> Result<(), Error> {
    match fs::symlink_metadata(root) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err(Error::UnsafeCachePath(root.to_path_buf()));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                // A world-writable parent cannot be trusted for a single
                // process's cache. Group-writable is tolerated (common for
                // shared temp dirs) but the single-process assumption is
                // documented; O_NOFOLLOW + mode 0600 protect the file itself.
                if meta.mode() & 0o002 != 0 {
                    return Err(Error::UnsafeCachePath(root.to_path_buf()));
                }
            }
            Ok(())
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                let mut builder = fs::DirBuilder::new();
                builder.recursive(true).mode(0o700);
                builder
                    .create(root)
                    .map_err(|e| Error::Cache(root.display().to_string(), e.to_string()))?;
            }
            #[cfg(not(unix))]
            fs::create_dir_all(root)
                .map_err(|e| Error::Cache(root.display().to_string(), e.to_string()))?;
            Ok(())
        }
        Err(e) => Err(Error::Cache(root.display().to_string(), e.to_string())),
    }
}

/// Serialize (bounded before allocation of the temp file), write, set 0600,
/// sync, then rename. A failure before the rename leaves the old file intact.
pub fn write_snapshot(
    root: &Path,
    snapshot: &ListSnapshot,
    limits: &Limits,
    hooks: WriteHooks,
) -> Result<(), Error> {
    let path = snapshot_path(root, &snapshot.source_id)?;
    let bytes = serde_json::to_vec(snapshot)
        .map_err(|e| Error::CacheWrite(snapshot.source_id.clone(), e.to_string()))?;
    if bytes.len() as u64 > limits.max_snapshot_bytes {
        return Err(Error::CacheWrite(
            snapshot.source_id.clone(),
            "serialized snapshot exceeds the byte limit".into(),
        ));
    }
    check_parent(root)?;
    if let Ok(meta) = fs::symlink_metadata(&path) {
        if meta.file_type().is_symlink() {
            return Err(Error::UnsafeCachePath(path.clone()));
        }
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut temp = tempfile::Builder::new()
        .prefix(".sub-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|e| Error::CacheWrite(snapshot.source_id.clone(), e.to_string()))?;
    {
        let file = temp.as_file_mut();
        file.write_all(&bytes)
            .map_err(|e| Error::CacheWrite(snapshot.source_id.clone(), e.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|e| Error::CacheWrite(snapshot.source_id.clone(), e.to_string()))?;
        }
        file.sync_all()
            .map_err(|e| Error::CacheWrite(snapshot.source_id.clone(), e.to_string()))?;
    }
    (hooks.before_rename)(&path).map_err(|e| {
        Error::CacheWrite(snapshot.source_id.clone(), format!("before rename: {e}"))
    })?;
    temp.persist(&path)
        .map_err(|e| Error::CacheWrite(snapshot.source_id.clone(), e.to_string()))?;
    // Best effort by contract: the rename already committed.
    let _ = (hooks.after_rename)(parent);
    Ok(())
}
