//! Read stored JPEGs only from the generated UUID/day/UUID layout. These checks
//! reject static symlinks and traversal; the configured storage tree is trusted
//! against external filesystem replacement, not an OS sandbox for local admins.
use std::{
    io,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub fn blob_path(root: &Path, agent: Uuid, reference: &str) -> Option<PathBuf> {
    let mut parts = reference.split('/');
    let owner = parts.next()?;
    let day = parts.next()?;
    let file = parts.next()?;
    if parts.next().is_some()
        || owner != agent.to_string()
        || day.len() != 8
        || !day.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let date = chrono::NaiveDate::parse_from_str(day, "%Y%m%d").ok()?;
    if date.format("%Y%m%d").to_string() != day {
        return None;
    }
    let uid = Uuid::parse_str(file.strip_suffix(".jpg")?).ok()?;
    if file != format!("{uid}.jpg") {
        return None;
    }
    Some(root.join(owner).join(day).join(file))
}

pub fn read_blob(root: &Path, agent: Uuid, reference: &str) -> io::Result<Vec<u8>> {
    let path = blob_path(root, agent, reference)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid blob reference"))?;
    check_path(root, &path, false)?;
    std::fs::read(path)
}

/// Cache paths are server-generated siblings under the already validated day.
/// Missing cache components are fine; symlinks and non-directory ancestors are not.
pub fn check_path(root: &Path, path: &Path, allow_missing: bool) -> io::Result<()> {
    // A missing/unavailable mount root is not evidence that a particular frame
    // has been deleted. Preserve its DB row and report an error for retry.
    let root_meta = std::fs::symlink_metadata(root)
        .map_err(|_| io::Error::other("Recall storage root unavailable"))?;
    if !root_meta.is_dir() || root_meta.file_type().is_symlink() {
        return Err(io::Error::other("unsafe Recall storage root"));
    }
    let relative = path
        .strip_prefix(root)
        .map_err(|_| io::Error::other("invalid blob path"))?;
    if relative
        .components()
        .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(io::Error::other("invalid blob path"));
    }
    let mut current = root.to_path_buf();
    for part in relative.components() {
        current.push(part);
        let meta = match std::fs::symlink_metadata(&current) {
            Ok(meta) => meta,
            Err(e) if allow_missing && e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        if meta.file_type().is_symlink() {
            return Err(io::Error::other("unsafe Recall blob path"));
        }
        let leaf = current == path;
        if (leaf && !meta.is_file()) || (!leaf && !meta.is_dir()) {
            return Err(io::Error::other("invalid Recall blob file type"));
        }
    }
    Ok(())
}
