//! Durable on-disk spool for screen-history ("Recall") keyframes.
//!
//! Keyframes used to go straight from the capture thread onto the session's
//! outbound channel with a `try_send`, which meant every frame captured while the
//! agent was disconnected — reconnect backoff, laptop asleep, server restart,
//! VPN drop — was silently discarded. A Recall timeline with unexplained holes in
//! it is worse than no timeline, so capture now always lands here first.
//!
//! The spool is the single hand-off point between capture and the session:
//!
//! * capture thread → [`Spool::push`] (durable, survives agent restarts)
//! * session → [`Spool::pending`] → send → server ack → [`Spool::remove`]
//!
//! Frames are only removed once the server has acknowledged persisting them, so
//! an interrupted session re-sends whatever was in flight. The server dedupes on
//! the `uid` written here, which makes that retry idempotent.
//!
//! Disk use is bounded by `max_bytes`: when the spool is over budget the *oldest*
//! frames are evicted first, degrading to "we kept the most recent N hours" rather
//! than filling the user's disk.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context as _, Result};
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

use crate::screen_history::HistoryFrame;

/// Magic + version prefix so a truncated or foreign file is rejected cheaply.
const MAGIC: &[u8; 4] = b"VRF1";
/// Spool file extension.
const EXT: &str = "vrf";
/// Default disk budget for spooled keyframes (bytes).
pub const DEFAULT_MAX_BYTES: u64 = 512 * 1024 * 1024;

/// Metadata header stored alongside the JPEG bytes in each spool file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameHeader {
    /// Client-generated id. Echoed by the server in its ack and used as the
    /// server-side dedup key, so a re-sent frame can never double-insert.
    pub uid: String,
    /// RFC3339 UTC. Kept as a string because it is forwarded to the server
    /// verbatim, and because the agent's `chrono` is built without `serde`.
    pub captured_at: String,
    /// Epoch-ms copy of `captured_at`, used for spool ordering without reparsing.
    pub captured_ms: i64,
    pub monitor: usize,
    pub w: u32,
    pub h: u32,
    /// u64 aHash as a decimal string (JSON numbers lose precision past 2^53).
    pub phash: String,
    pub ocr_text: Option<String>,
    /// Per-word OCR boxes (normalized 0..1). Defaulted so spool files written by an
    /// older agent still load after an upgrade instead of being discarded.
    #[serde(default)]
    pub ocr_words: Vec<crate::screen_history::OcrWord>,
}

/// A spool entry read back off disk, ready to ship.
#[derive(Debug, Clone)]
pub struct SpooledFrame {
    pub header: FrameHeader,
    pub jpeg: Vec<u8>,
}

/// A bounded, durable FIFO of keyframes awaiting server acknowledgement.
#[derive(Debug, Clone)]
pub struct Spool {
    dir: PathBuf,
    max_bytes: u64,
}

impl Spool {
    /// Open (creating if needed) the spool directory.
    pub fn new(dir: PathBuf, max_bytes: u64) -> Result<Self> {
        fs::create_dir_all(&dir)
            .with_context(|| format!("creating screen spool dir {}", dir.display()))?;
        Ok(Self { dir, max_bytes })
    }

    /// Append a captured keyframe. Returns the assigned `uid`.
    ///
    /// The write is atomic (temp file + rename) so a crash mid-write can never
    /// leave a half-frame that later fails to parse. Enforcing the disk budget
    /// afterwards means a single oversized frame is accepted and then trimmed,
    /// rather than being rejected outright.
    pub fn push(&self, frame: &HistoryFrame) -> Result<String> {
        let uid = uuid::Uuid::new_v4().to_string();
        let captured_ms = frame.captured_at.timestamp_millis();
        let header = FrameHeader {
            uid: uid.clone(),
            captured_at: frame.captured_at.to_rfc3339(),
            captured_ms,
            monitor: frame.monitor,
            w: frame.width,
            h: frame.height,
            phash: frame.phash.to_string(),
            ocr_text: frame.ocr_text.clone(),
            ocr_words: frame.ocr_words.clone(),
        };
        let header_bytes = serde_json::to_vec(&header)?;

        // Filename sorts chronologically: capture order is replay order, and the
        // uid suffix keeps two frames in the same millisecond from colliding.
        let name = format!("{:013}-{uid}.{EXT}", captured_ms.max(0));
        let final_path = self.dir.join(&name);
        let tmp_path = self.dir.join(format!("{name}.tmp"));

        {
            let mut f = fs::File::create(&tmp_path)
                .with_context(|| format!("creating {}", tmp_path.display()))?;
            f.write_all(MAGIC)?;
            f.write_all(&(header_bytes.len() as u32).to_le_bytes())?;
            f.write_all(&header_bytes)?;
            f.write_all(&frame.jpeg)?;
            f.flush()?;
        }
        fs::rename(&tmp_path, &final_path).with_context(|| {
            format!("renaming {} -> {}", tmp_path.display(), final_path.display())
        })?;

        self.enforce_budget();
        Ok(uid)
    }

    /// Oldest-first paths of frames awaiting acknowledgement, capped at `limit`.
    pub fn pending(&self, limit: usize) -> Vec<PathBuf> {
        let mut paths = self.entries();
        paths.truncate(limit);
        paths.into_iter().map(|(p, _)| p).collect()
    }

    /// Number of frames currently spooled.
    pub fn len(&self) -> usize {
        self.entries().len()
    }

    /// Read one spool file back into a sendable frame.
    pub fn load(path: &Path) -> Result<SpooledFrame> {
        let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        if bytes.len() < MAGIC.len() + 4 || &bytes[..4] != MAGIC {
            bail!("not a spool frame (bad magic): {}", path.display());
        }
        let hlen = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
        let hstart = MAGIC.len() + 4;
        let hend = hstart
            .checked_add(hlen)
            .filter(|e| *e <= bytes.len())
            .with_context(|| format!("truncated spool frame: {}", path.display()))?;
        let header: FrameHeader = serde_json::from_slice(&bytes[hstart..hend])
            .with_context(|| format!("bad spool header: {}", path.display()))?;
        Ok(SpooledFrame {
            header,
            jpeg: bytes[hend..].to_vec(),
        })
    }

    /// Drop an acknowledged frame. Missing files are not an error — a duplicate
    /// ack (or a concurrent eviction) is a benign race, not a failure.
    pub fn remove(path: &Path) {
        if let Err(e) = fs::remove_file(path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!("Screen spool: failed to remove {}: {e}", path.display());
            }
        }
    }

    /// Spool files (oldest first) with their sizes, skipping temp/foreign files.
    fn entries(&self) -> Vec<(PathBuf, u64)> {
        let Ok(rd) = fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut out: Vec<(PathBuf, u64)> = rd
            .flatten()
            .filter_map(|e| {
                let path = e.path();
                if path.extension().and_then(|s| s.to_str()) != Some(EXT) {
                    return None;
                }
                let len = e.metadata().ok()?.len();
                Some((path, len))
            })
            .collect();
        // Filenames are zero-padded epoch-ms, so lexical order is chronological.
        out.sort_by(|a, b| a.0.file_name().cmp(&b.0.file_name()));
        out
    }

    /// Evict oldest frames until the spool fits its disk budget.
    fn enforce_budget(&self) {
        let entries = self.entries();
        let mut total: u64 = entries.iter().map(|(_, n)| *n).sum();
        if total <= self.max_bytes {
            return;
        }
        let mut evicted = 0u32;
        for (path, len) in entries {
            if total <= self.max_bytes {
                break;
            }
            Self::remove(&path);
            total = total.saturating_sub(len);
            evicted += 1;
        }
        if evicted > 0 {
            debug!("Screen spool over budget: evicted {evicted} oldest keyframe(s).");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(ms: i64) -> HistoryFrame {
        HistoryFrame {
            captured_at: chrono::DateTime::from_timestamp_millis(ms).unwrap(),
            monitor: 0,
            width: 4,
            height: 3,
            jpeg: vec![7u8; 128],
            phash: u64::MAX,
            ocr_text: Some("hello".into()),
            ocr_words: vec![crate::screen_history::OcrWord {
                t: "hello".into(),
                x: 0.1,
                y: 0.2,
                w: 0.3,
                h: 0.05,
            }],
        }
    }

    #[test]
    fn round_trips_a_frame() {
        let dir = tempdir();
        let spool = Spool::new(dir.clone(), DEFAULT_MAX_BYTES).unwrap();
        let uid = spool.push(&frame(1_700_000_000_000)).unwrap();

        let pending = spool.pending(10);
        assert_eq!(pending.len(), 1);
        let loaded = Spool::load(&pending[0]).unwrap();
        assert_eq!(loaded.header.uid, uid);
        // u64 phash must survive the string round-trip without precision loss.
        assert_eq!(loaded.header.phash, u64::MAX.to_string());
        assert_eq!(loaded.header.ocr_text.as_deref(), Some("hello"));
        // Word geometry must survive the spool, or replayed frames lose selectable text.
        assert_eq!(loaded.header.ocr_words.len(), 1);
        assert_eq!(loaded.header.ocr_words[0].t, "hello");
        assert!((loaded.header.ocr_words[0].x - 0.1).abs() < 1e-6);
        assert_eq!(loaded.jpeg, vec![7u8; 128]);

        Spool::remove(&pending[0]);
        assert_eq!(spool.len(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pending_is_oldest_first() {
        let dir = tempdir();
        let spool = Spool::new(dir.clone(), DEFAULT_MAX_BYTES).unwrap();
        // Push out of chronological order; ordering must come from captured_at.
        spool.push(&frame(1_700_000_002_000)).unwrap();
        spool.push(&frame(1_700_000_000_000)).unwrap();
        spool.push(&frame(1_700_000_001_000)).unwrap();

        let stamps: Vec<i64> = spool
            .pending(10)
            .iter()
            .map(|p| Spool::load(p).unwrap().header.captured_ms)
            .collect();
        assert_eq!(
            stamps,
            vec![1_700_000_000_000, 1_700_000_001_000, 1_700_000_002_000]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn evicts_oldest_when_over_budget() {
        let dir = tempdir();
        // Budget fits roughly two frames (~128B payload + header each).
        let spool = Spool::new(dir.clone(), 600).unwrap();
        for i in 0..6 {
            spool.push(&frame(1_700_000_000_000 + i * 1000)).unwrap();
        }
        let remaining: Vec<i64> = spool
            .pending(10)
            .iter()
            .map(|p| Spool::load(p).unwrap().header.captured_ms)
            .collect();
        assert!(!remaining.is_empty(), "budget must not empty the spool");
        assert!(remaining.len() < 6, "oldest frames should have been evicted");
        // Whatever survived must be the newest frames, still in order.
        let mut sorted = remaining.clone();
        sorted.sort_unstable();
        assert_eq!(remaining, sorted);
        assert_eq!(*remaining.last().unwrap(), 1_700_000_005_000);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_a_corrupt_file() {
        let dir = tempdir();
        let spool = Spool::new(dir.clone(), DEFAULT_MAX_BYTES).unwrap();
        spool.push(&frame(1_700_000_000_000)).unwrap();
        let path = spool.pending(1).remove(0);
        fs::write(&path, b"JUNKjunkjunk").unwrap();
        assert!(Spool::load(&path).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    fn tempdir() -> PathBuf {
        let p = std::env::temp_dir().join(format!("vantyr-spool-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }
}
