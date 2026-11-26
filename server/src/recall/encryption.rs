//! Authenticated encryption for Recall image payloads. The path is authenticated,
//! so copying ciphertext between agents, frames or thumbnail sizes fails.
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::{
    aead::{self, Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM},
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const MAGIC: &[u8; 8] = b"VANTYR\0R";
const VERSION: u8 = 1;
const HEADER: usize = MAGIC.len() + 1 + 16 + 12;
const MARKER: &str = ".recall-encrypted";
const PENDING: &[u8] = b"migration-pending";
const READY: &[u8] = b"encrypted-ready";
const REKEY_PENDING: &[u8] = b"rekey-pending";
#[cfg(not(unix))]
const LOCK: &str = ".recall-lock";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyFile {
    version: u8,
    active_key: Uuid,
    keys: Vec<KeyEntry>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyEntry {
    id: Uuid,
    key: String,
}

/// Never derive Debug or Serialize for runtime key material.
pub struct Keyring {
    active: Uuid,
    keys: HashMap<Uuid, LessSafeKey>,
}

fn crypto_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "Recall ciphertext authentication failed",
    )
}

impl Keyring {
    fn load(path: &Path) -> Result<Self> {
        let meta = fs::symlink_metadata(path).context("Recall keyring file unavailable")?;
        ensure!(
            meta.is_file() && !meta.file_type().is_symlink(),
            "Recall keyring must be a regular file"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            ensure!(
                meta.permissions().mode() & 0o077 == 0,
                "Recall keyring must not grant group/other permissions (use 0600 or 0400)"
            );
        }
        let bytes = fs::read(path).context("Cannot read Recall keyring")?;
        // Never include deserialization input (which might contain key material) in errors.
        let file: KeyFile = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("Invalid Recall keyring JSON"))?;
        ensure!(
            file.version == VERSION,
            "Unsupported Recall keyring version"
        );
        let mut keys = HashMap::new();
        for entry in file.keys {
            let raw = STANDARD
                .decode(&entry.key)
                .map_err(|_| anyhow::anyhow!("Invalid Recall key encoding"))?;
            let key = UnboundKey::new(&AES_256_GCM, &raw)
                .map_err(|_| anyhow::anyhow!("Recall key must contain 32 bytes"))?;
            ensure!(!entry.id.is_nil(), "Invalid Recall key ID");
            ensure!(
                keys.insert(entry.id, LessSafeKey::new(key)).is_none(),
                "Duplicate Recall key ID"
            );
        }
        ensure!(
            keys.contains_key(&file.active_key),
            "Recall active key missing from keyring"
        );
        Ok(Self {
            active: file.active_key,
            keys,
        })
    }

    fn encrypt(&self, reference: &str, plain: &[u8]) -> io::Result<Vec<u8>> {
        let mut nonce = [0u8; 12];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| io::Error::other("Recall random nonce generation failed"))?;
        let mut header = Vec::with_capacity(HEADER);
        header.extend_from_slice(MAGIC);
        header.push(VERSION);
        header.extend_from_slice(self.active.as_bytes());
        header.extend_from_slice(&nonce);
        let mut encrypted = plain.to_vec();
        self.keys[&self.active]
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(aad(&header, reference)),
                &mut encrypted,
            )
            .map_err(|_| io::Error::other("Recall encryption failed"))?;
        header.extend_from_slice(&encrypted);
        Ok(header)
    }

    fn decrypt(&self, reference: &str, stored: Vec<u8>) -> io::Result<Vec<u8>> {
        let id = envelope_key(&stored)?;
        let key = self.keys.get(&id).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "Recall ciphertext key unavailable",
            )
        })?;
        let nonce = stored[HEADER - 12..HEADER]
            .try_into()
            .map_err(|_| crypto_error())?;
        let mut encrypted = stored[HEADER..].to_vec();
        let plain = key
            .open_in_place(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(aad(&stored[..HEADER], reference)),
                &mut encrypted,
            )
            .map_err(|_| crypto_error())?;
        let len = plain.len();
        encrypted.truncate(len);
        Ok(encrypted)
    }
}

fn aad(header: &[u8], reference: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(header.len() + reference.len());
    aad.extend_from_slice(header);
    aad.extend_from_slice(reference.as_bytes());
    aad
}

fn envelope_key(stored: &[u8]) -> io::Result<Uuid> {
    if stored.len() < HEADER + aead::MAX_TAG_LEN
        || !stored.starts_with(MAGIC)
        || stored[MAGIC.len()] != VERSION
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Recall ciphertext envelope missing or unsupported",
        ));
    }
    Uuid::from_slice(&stored[MAGIC.len() + 1..HEADER - 12]).map_err(|_| crypto_error())
}

/// Obtain a private file handle. New files are always created exclusively.
fn private_create(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Create missing directories with owner-only permissions (existing permissions
/// are deliberately left alone).
pub(super) fn private_dirs(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

/// Never truncate existing data. A crash leaves either the previous file or a
/// complete renamed file. Temporary files contain ciphertext in encrypted mode.
pub(super) fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("Missing Recall parent directory"))?;
    let leaf = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| io::Error::other("Invalid Recall filename"))?;
    let temp = parent.join(format!(".recall-tmp-{}-{leaf}", Uuid::new_v4()));
    let mut file = private_create(&temp)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)?;
        sync_dir(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn sync_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn keyring_path() -> Result<Option<PathBuf>> {
    match std::env::var_os("SCREEN_HISTORY_KEYRING_FILE") {
        None => Ok(None),
        Some(path) if path.is_empty() => bail!("SCREEN_HISTORY_KEYRING_FILE is empty"),
        Some(path) => Ok(Some(path.into())),
    }
}

fn load_configured(root: &Path, path: Option<PathBuf>) -> Result<Option<Arc<Keyring>>> {
    let Some(path) = path else {
        return Ok(None);
    };
    let canonical = fs::canonicalize(&path).context("Recall keyring path unavailable")?;
    ensure!(
        !canonical.starts_with(fs::canonicalize(root)?),
        "Recall keyring must be outside SCREEN_HISTORY_DIR"
    );
    Ok(Some(Arc::new(Keyring::load(&path)?)))
}

/// Hold this lock for the entire server or offline migration run. Other versions
/// of the server predating this feature do not know the lock: stop them manually.
fn lock(root: &Path) -> Result<File> {
    let meta = fs::symlink_metadata(root).context("Recall root unavailable")?;
    ensure!(
        meta.is_dir() && !meta.file_type().is_symlink(),
        "Unsafe Recall root"
    );
    // On Unix, lock the root directory itself: even a dry run leaves no lock file.
    #[cfg(unix)]
    let file = File::open(root)?;
    #[cfg(not(unix))]
    let file = {
        let path = root.join(LOCK);
        match private_create(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                let meta = fs::symlink_metadata(&path)?;
                ensure!(
                    meta.is_file() && !meta.file_type().is_symlink(),
                    "Unsafe Recall lock file"
                );
                OpenOptions::new().write(true).open(path)?
            }
            Err(e) => return Err(e.into()),
        }
    };
    file.try_lock()
        .context("Recall storage is in use; stop the server before migration")?;
    Ok(file)
}

fn marker(root: &Path) -> Result<Option<Vec<u8>>> {
    let path = root.join(MARKER);
    match fs::symlink_metadata(&path) {
        Ok(meta) => {
            ensure!(
                meta.is_file() && !meta.file_type().is_symlink(),
                "Unsafe Recall encryption marker"
            );
            Ok(Some(fs::read(path)?))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn write_marker(root: &Path, keyring: &Keyring, status: &[u8]) -> Result<()> {
    atomic_write(&root.join(MARKER), &keyring.encrypt(MARKER, status)?)?;
    Ok(())
}

/// Strict startup: encryption cannot be silently turned off and a migration
/// interrupted halfway is never served. Fresh stores can enable encryption directly.
pub fn initialize(root: &Path) -> Result<(Option<Arc<Keyring>>, File)> {
    private_dirs(root)?;
    let guard = lock(root)?;
    let keyring = load_configured(root, keyring_path()?)?;
    validate_startup(root, keyring.as_deref())?;
    Ok((keyring, guard))
}

fn validate_startup(root: &Path, keyring: Option<&Keyring>) -> Result<()> {
    match (marker(root)?, keyring) {
        (Some(_), None) => {
            bail!("Recall storage is encrypted; SCREEN_HISTORY_KEYRING_FILE is required")
        }
        (Some(bytes), Some(keys)) => {
            ensure!(
                envelope_key(&bytes)? == keys.active,
                "Recall active key changed; run offline recall-encrypt migration"
            );
            ensure!(
                keys.decrypt(MARKER, bytes)? == READY,
                "Recall migration incomplete; run offline recall-encrypt migration"
            );
        }
        (None, Some(keys)) => {
            let mut existing = false;
            visit_images(root, &mut |_, _| {
                existing = true;
                Ok(())
            })?;
            ensure!(
                !existing,
                "Existing Recall images require offline recall-encrypt migration"
            );
            write_marker(root, keys, READY)?;
        }
        (None, None) => {
            // Also catch incomplete restores of an encrypted store whose marker
            // was accidentally excluded. Never downgrade it to a plaintext store.
            ensure!(!contains_ciphertext(root, 4)?, "Recall ciphertext found without encryption marker/keyring; restore the marker and keys");
        }
    }
    Ok(())
}

fn contains_ciphertext(dir: &Path, depth: usize) -> Result<bool> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() && depth > 0 && contains_ciphertext(&entry.path(), depth - 1)? {
            return Ok(true);
        }
        if ty.is_file() {
            let mut prefix = [0u8; MAGIC.len()];
            let mut f = File::open(entry.path())?;
            match f.read_exact(&mut prefix) {
                Ok(()) if prefix == *MAGIC => return Ok(true),
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    Ok(false)
}

/// A running server must not interpret a replaced/unmounted encrypted root
/// (or a missing keyring) as evidence that individual frames were deleted.
pub(super) fn ensure_store_mode(root: &Path, keys: Option<&Keyring>) -> io::Result<()> {
    let marker = marker(root).map_err(io::Error::other)?;
    match (marker, keys) {
        (None, None) => Ok(()),
        (Some(bytes), Some(keys)) => {
            if envelope_key(&bytes)? == keys.active && keys.decrypt(MARKER, bytes)? == READY {
                Ok(())
            } else {
                Err(crypto_error())
            }
        }
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Recall storage marker/keyring unavailable or invalid",
        )),
    }
}

/// Runtime reads/writes take the canonical relative path as AAD, for both frames
/// and thumbnails. Legacy mode refuses ciphertext instead of serving it raw.
pub(super) fn decode(
    keyring: Option<&Keyring>,
    reference: &str,
    stored: Vec<u8>,
) -> io::Result<Vec<u8>> {
    match keyring {
        Some(keys) => keys.decrypt(reference, stored),
        None if stored.starts_with(MAGIC) => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Recall encryption keyring required",
        )),
        None => Ok(stored),
    }
}

pub(super) fn encode(
    keyring: Option<&Keyring>,
    reference: &str,
    plain: &[u8],
) -> io::Result<Vec<u8>> {
    match keyring {
        Some(keys) => keys.encrypt(reference, plain),
        None => Ok(plain.to_vec()),
    }
}

/// Refuse unexpected storage entries instead of declaring an incomplete migration
/// successful. The retention trash must be empty before migration. An interrupted
/// atomic write may leave an encrypted temp; keep it, and recognize only our exact
/// generated name (no other unexpected content is silently ignored).
fn visit_images(root: &Path, callback: &mut impl FnMut(&Path, bool) -> Result<()>) -> Result<()> {
    fn entries(dir: &Path) -> Result<impl Iterator<Item = Result<fs::DirEntry>>> {
        // Snapshot a single directory so atomic renames in the callback cannot
        // cause traversal to see newly-created temp names or skip entries.
        let entries = fs::read_dir(dir)?.collect::<io::Result<Vec<_>>>()?;
        Ok(entries.into_iter().map(Ok))
    }
    fn name(entry: &fs::DirEntry) -> Result<String> {
        entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("Non-UTF8 Recall storage entry"))
    }
    fn dir(entry: &fs::DirEntry) -> Result<()> {
        ensure!(
            entry.file_type()?.is_dir(),
            "Unsafe/non-directory Recall entry: {}",
            entry.path().display()
        );
        Ok(())
    }
    fn uuid(s: &str) -> bool {
        Uuid::parse_str(s).is_ok_and(|id| id.to_string() == s)
    }
    fn temp_target(s: &str) -> Option<&str> {
        let rest = s.strip_prefix(".recall-tmp-")?;
        let (id, leaf) = rest.split_at_checked(36)?;
        let leaf = leaf.strip_prefix('-')?;
        uuid(id).then_some(leaf)
    }
    fn image(
        entry: &fs::DirEntry,
        callback: &mut impl FnMut(&Path, bool) -> Result<()>,
    ) -> Result<()> {
        let n = name(entry)?;
        ensure!(
            entry.file_type()?.is_file(),
            "Unsafe/non-file Recall image: {}",
            entry.path().display()
        );
        if let Some(target) = temp_target(&n) {
            ensure!(
                target.strip_suffix(".jpg").is_some_and(uuid),
                "Invalid Recall temporary file"
            );
            // Migration always replaces an existing file. If the destination
            // is present, interrupted temporary bytes are not its only copy.
            let dest = entry.path().with_file_name(target);
            let dest_meta = fs::symlink_metadata(&dest).context(
                "Temporary Recall file has no original; preserve it for manual recovery",
            )?;
            ensure!(
                dest_meta.is_file() && !dest_meta.file_type().is_symlink(),
                "Unsafe Recall temporary file target"
            );
            return callback(&entry.path(), true);
        }
        ensure!(
            n.strip_suffix(".jpg").is_some_and(uuid),
            "Unexpected Recall image file: {}",
            entry.path().display()
        );
        callback(&entry.path(), false)
    }
    for owner in entries(root)? {
        let owner = owner?;
        let n = name(&owner)?;
        if matches!(n.as_str(), MARKER | ".recall-lock") {
            ensure!(owner.file_type()?.is_file(), "Unsafe Recall control file");
            continue;
        }
        if n == ".retention-trash" {
            dir(&owner)?;
            ensure!(
                entries(&owner.path())?.next().is_none(),
                "Recall retention trash is not empty; finish retention before encryption"
            );
            continue;
        }
        if temp_target(&n) == Some(MARKER) {
            ensure!(
                owner.file_type()?.is_file(),
                "Unsafe Recall marker temporary file"
            );
            callback(&owner.path(), true)?;
            continue;
        }
        ensure!(
            uuid(&n),
            "Unexpected Recall storage entry: {}",
            owner.path().display()
        );
        dir(&owner)?;
        for day in entries(&owner.path())? {
            let day = day?;
            let n = name(&day)?;
            ensure!(
                n.len() == 8
                    && chrono::NaiveDate::parse_from_str(&n, "%Y%m%d")
                        .is_ok_and(|date| date.format("%Y%m%d").to_string() == n),
                "Unexpected Recall day: {}",
                day.path().display()
            );
            dir(&day)?;
            for entry in entries(&day.path())? {
                let entry = entry?;
                match name(&entry)?.as_str() {
                    "thumb-160" | "thumb-320" | "thumb-640" => {
                        dir(&entry)?;
                        for cached in entries(&entry.path())? {
                            image(&cached?, callback)?;
                        }
                    }
                    _ => image(&entry, callback)?,
                }
            }
        }
    }
    Ok(())
}

fn relative(root: &Path, path: &Path) -> Result<String> {
    // Joining components explicitly keeps AAD independent of host separators.
    path.strip_prefix(root)?
        .components()
        .map(|c| c.as_os_str().to_str().context("Invalid Recall path"))
        .collect::<Result<Vec<_>>>()
        .map(|p| p.join("/"))
}

pub(super) fn path_reference(root: &Path, path: &Path) -> io::Result<String> {
    relative(root, path).map_err(|_| io::Error::other("Invalid Recall path"))
}

#[derive(Default, Debug, PartialEq, Eq)]
struct MigrationReport {
    plaintext: usize,
    rekey: usize,
    current: usize,
    interrupted_temps: usize,
}

fn migrate(root: &Path, keys: &Keyring, apply: bool) -> Result<MigrationReport> {
    let allow_plaintext = if let Some(bytes) = marker(root)? {
        let state = keys.decrypt(MARKER, bytes)?;
        ensure!(
            state == READY || state == PENDING || state == REKEY_PENDING,
            "Unknown Recall encryption marker state"
        );
        state == PENDING
    } else {
        true
    };

    let mut report = MigrationReport::default();
    // Complete preflight validates every old ciphertext before any modification.
    visit_images(root, &mut |path, temp| {
        if temp {
            report.interrupted_temps += 1;
            return Ok(());
        }
        let bytes = fs::read(path)?;
        if bytes.starts_with(MAGIC) {
            let id = envelope_key(&bytes)?;
            keys.decrypt(&relative(root, path)?, bytes)
                .with_context(|| format!("Cannot authenticate {}", path.display()))?;
            if id == keys.active {
                report.current += 1;
            } else {
                report.rekey += 1;
            }
        } else {
            ensure!(allow_plaintext && bytes.starts_with(&[0xff, 0xd8]), "Unrecognized or unexpectedly plaintext Recall image; preserve it for inspection: {}", path.display());
            report.plaintext += 1;
        }
        Ok(())
    })?;
    if !apply {
        return Ok(report);
    }

    write_marker(
        root,
        keys,
        if allow_plaintext {
            PENDING
        } else {
            REKEY_PENDING
        },
    )?;
    visit_images(root, &mut |path, temp| {
        if temp {
            // The completed preflight validated the original; its temporary
            // replacement is disposable and is never the only copy.
            fs::remove_file(path)?;
            sync_dir(path.parent().context("Missing Recall parent")?)?;
            return Ok(());
        }
        let bytes = fs::read(path)?;
        let reference = relative(root, path)?;
        let plain = if bytes.starts_with(MAGIC) {
            let id = envelope_key(&bytes)?;
            let plain = keys.decrypt(&reference, bytes)?;
            if id == keys.active {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
                }
                return Ok(());
            }
            plain
        } else {
            bytes
        };
        let encrypted = keys.encrypt(&reference, &plain)?;
        // Verify the actual envelope before replacing the previous content.
        ensure!(
            keys.decrypt(&reference, encrypted.clone())? == plain,
            "Recall encryption verification failed"
        );
        atomic_write(path, &encrypted)?;
        Ok(())
    })?;
    write_marker(root, keys, READY)?;
    Ok(report)
}

fn generate(path: &Path) -> Result<()> {
    let mut raw = [0u8; 32];
    SystemRandom::new()
        .fill(&mut raw)
        .map_err(|_| anyhow::anyhow!("Recall key generation failed"))?;
    let id = Uuid::new_v4();
    let keyfile = KeyFile {
        version: VERSION,
        active_key: id,
        keys: vec![KeyEntry {
            id,
            key: STANDARD.encode(raw),
        }],
    };
    let mut file = private_create(path)
        .context("Cannot create Recall keyring (existing files are never overwritten)")?;
    file.write_all(&serde_json::to_vec_pretty(&keyfile)?)?;
    file.sync_all()?;
    sync_dir(
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?;
    Ok(())
}

/// These commands intentionally do not connect to the database or launch the server.
pub fn command(args: &[String]) -> Result<bool> {
    match args.first().map(String::as_str) {
        Some("recall-keygen") => {
            ensure!(
                args.len() == 2,
                "Usage: vantyr-server recall-keygen <new-keyring-file>"
            );
            generate(Path::new(&args[1]))?;
            println!("Recall keyring created.");
            Ok(true)
        }
        Some("recall-encrypt") => {
            ensure!(
                matches!(args.len(), 2 | 4)
                    && matches!(args[1].as_str(), "--dry-run" | "--apply")
                    && (args.len() == 2 || args[2] == "--keyring"),
                "Usage: vantyr-server recall-encrypt --dry-run|--apply [--keyring PATH]"
            );
            let root = crate::config::screen_history_dir();
            let _guard = lock(&root)?;
            let path = if args.len() == 4 {
                Some(PathBuf::from(&args[3]))
            } else {
                keyring_path()?
            };
            let keys =
                load_configured(&root, path)?.context("SCREEN_HISTORY_KEYRING_FILE is required")?;
            let apply = args[1] == "--apply";
            let report = migrate(&root, &keys, apply)?;
            println!(
                "Recall {}: {} plaintext, {} old-key, {} current-key images, {} interrupted temp files{}",
                if apply {
                    "migration complete"
                } else {
                    "dry run"
                },
                report.plaintext,
                report.rekey,
                report.current,
                report.interrupted_temps,
                if apply {
                    " (plaintext and old-key images converted)"
                } else {
                    " (no image changes)"
                }
            );
            Ok(true)
        }
        _ => Ok(false),
    }
}

#[cfg(test)]
pub(crate) fn test_initialize(root: &Path, keys: &Keyring) {
    private_dirs(root).unwrap();
    validate_startup(root, Some(keys)).unwrap();
}

#[cfg(test)]
pub(crate) fn test_keyring(id: Uuid, byte: u8) -> Arc<Keyring> {
    Arc::new(Keyring {
        active: id,
        keys: HashMap::from([(
            id,
            LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &[byte; 32]).unwrap()),
        )]),
    })
}

#[cfg(test)]
mod tests;
