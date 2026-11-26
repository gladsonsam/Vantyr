//! Bounded, symlink-refusing file access and no-clobber atomic publication.
//!
//! There is deliberately no overwrite mode. A successful `write_new_atomic`
//! means: a fresh file was fully written and file-synced, then published with a
//! single same-directory rename that refuses to replace an existing entry.
//! The parent-directory sync after the rename is best effort. If it fails, the
//! new entry is already published, so the call still succeeds; what is not
//! guaranteed in that case is survival of the directory entry across sudden
//! power loss. There is never an "old file was left intact" outcome to report,
//! because creation only succeeds when no entry existed.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use crate::error::{PkiError, Result};

/// Max encrypted vault bytes accepted for decryption. Well under any sane CA
/// envelope; bounds work done on an attacker-supplied file before age parses it.
pub const MAX_VAULT_BYTES: u64 = 1 << 20;
/// Max operator secret file bytes. A passphrase file is tiny.
pub const MAX_SECRET_BYTES: u64 = 4096;
/// Max public metadata bytes.
pub const MAX_METADATA_BYTES: u64 = 1 << 20;
/// Max decrypted vault payload bytes.
pub const MAX_PAYLOAD_BYTES: usize = 64 * 1024;

/// Read a bounded regular file. Private files must be exactly mode 0600 and
/// must not be symlinks; a symlink is rejected both before and during open.
pub fn read_bounded_private(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let meta = fs::symlink_metadata(path).map_err(|e| PkiError::Io {
        op: "stat",
        detail: e.to_string(),
    })?;
    if meta.file_type().is_symlink() {
        return Err(PkiError::SymlinkRejected);
    }
    if !meta.file_type().is_file() {
        return Err(PkiError::NotRegularFile);
    }
    if meta.len() > limit {
        return Err(PkiError::TooLarge {
            what: "file",
            bytes: meta.len(),
            limit,
        });
    }
    check_owner_only(path, &meta)?;

    let file = open_no_follow(path)?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| PkiError::Io {
            op: "read",
            detail: e.to_string(),
        })?;
    if bytes.len() as u64 > limit {
        return Err(PkiError::TooLarge {
            what: "file",
            bytes: bytes.len() as u64,
            limit,
        });
    }
    Ok(bytes)
}

/// Read a bounded public file. Symlinks and non-regular files are still
/// refused, but no particular mode is required.
pub fn read_bounded_public(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let meta = fs::symlink_metadata(path).map_err(|e| PkiError::Io {
        op: "stat",
        detail: e.to_string(),
    })?;
    if meta.file_type().is_symlink() {
        return Err(PkiError::SymlinkRejected);
    }
    if !meta.file_type().is_file() {
        return Err(PkiError::NotRegularFile);
    }
    if meta.len() > limit {
        return Err(PkiError::TooLarge {
            what: "file",
            bytes: meta.len(),
            limit,
        });
    }
    let file = open_no_follow(path)?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| PkiError::Io {
            op: "read",
            detail: e.to_string(),
        })?;
    if bytes.len() as u64 > limit {
        return Err(PkiError::TooLarge {
            what: "file",
            bytes: bytes.len() as u64,
            limit,
        });
    }
    Ok(bytes)
}

/// Publish a brand-new file atomically. `mode` is applied to the temporary
/// file before any bytes are written.
pub fn write_new_atomic(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    if fs::symlink_metadata(path).is_ok() {
        return Err(PkiError::AlreadyExists);
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temp = tempfile::Builder::new()
        .prefix(".vantyr-pki-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|e| PkiError::Io {
            op: "create temp",
            detail: e.to_string(),
        })?;
    {
        let file = temp.as_file_mut();
        set_mode(file, mode)?;
        file.write_all(bytes).map_err(|e| PkiError::Io {
            op: "write",
            detail: e.to_string(),
        })?;
        file.sync_all().map_err(|e| PkiError::Io {
            op: "sync file",
            detail: e.to_string(),
        })?;
    }
    temp.persist_noclobber(path).map_err(|e| {
        if e.error.kind() == std::io::ErrorKind::AlreadyExists {
            PkiError::AlreadyExists
        } else {
            PkiError::Io {
                op: "publish",
                detail: e.error.to_string(),
            }
        }
    })?;

    // Best effort by contract: the rename has already committed. Do not turn a
    // directory-sync failure into an error that falsely claims the old state
    // survived, and do not claim power-loss durability when it failed.
    let _ = File::open(parent).and_then(|dir| dir.sync_all());
    Ok(())
}

#[cfg(unix)]
fn check_owner_only(path: &Path, meta: &fs::Metadata) -> Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let found = meta.permissions().mode() & 0o777;
    if found != 0o600 {
        return Err(PkiError::BadMode {
            file: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "<unknown>".into()),
            expected: 0o600,
            found,
        });
    }
    // Metadata on the symlink itself is already checked; also refuse a mode
    // that would allow group/other access through a hard link to the inode.
    if meta.mode() & 0o777 != 0o600 {
        return Err(PkiError::BadMode {
            file: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "<unknown>".into()),
            expected: 0o600,
            found: meta.mode() & 0o777,
        });
    }
    Ok(())
}

#[cfg(not(unix))]
fn check_owner_only(_path: &Path, _meta: &fs::Metadata) -> Result<()> {
    // Non-Unix targets cannot assert POSIX mode bits; the type and size checks
    // still apply. This crate's supported deployment target is Unix.
    Ok(())
}

#[cfg(unix)]
fn set_mode(file: &File, mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(mode))
        .map_err(|e| PkiError::Io {
            op: "chmod temp",
            detail: e.to_string(),
        })
}

#[cfg(not(unix))]
fn set_mode(_file: &File, _mode: u32) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn open_no_follow(path: &Path) -> Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| PkiError::Io {
            op: "open",
            detail: e.to_string(),
        })
}

#[cfg(not(unix))]
fn open_no_follow(path: &Path) -> Result<File> {
    OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|e| PkiError::Io {
            op: "open",
            detail: e.to_string(),
        })
}
