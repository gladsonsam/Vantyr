//! Frame JPEG bytes and cached thumbnails.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::ConnectInfo;
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use uuid::Uuid;

use crate::error::ApiError;
use crate::http::RequireOperator;
use crate::recall::db;
use crate::state::agent_lifecycle::{spawn_blocking_ingestion, IngestionLease};
use crate::state::AppState;

use super::{audit_recall, AUDIT_REPLAY};
use crate::http::audit_ip;

/// Widths the thumbnail endpoint will actually produce, smallest first.
///
/// A requested width snaps to the nearest of these rather than being honoured
/// literally: each distinct width is a cached file on disk, so accepting arbitrary
/// values would let a caller fill the blob store with near-identical renders.
const THUMB_WIDTHS: [u32; 3] = [160, 320, 640];

/// Snap a requested width to a cacheable bucket.
fn snap_thumb_width(requested: u32) -> u32 {
    *THUMB_WIDTHS
        .iter()
        .min_by_key(|w| w.abs_diff(requested))
        .unwrap_or(&THUMB_WIDTHS[0])
}

/// Cache location for a `width`-wide render of `blob_ref`.
///
/// Deliberately nested *inside* the frame's own day directory
/// (`<agent>/<YYYYMMDD>/thumb-<w>/<uuid>.jpg`): retention drops whole day dirs
/// recursively, so thumbnails expire with their source frame without retention
/// needing to know they exist.
fn thumb_path(root: &std::path::Path, blob_ref: &str, width: u32) -> Option<std::path::PathBuf> {
    let rel = std::path::Path::new(blob_ref);
    let file = rel.file_name()?;
    // A bare filename has an empty parent, which would place the thumbnail at the
    // blob-store root — outside any day directory, so retention would never reap it.
    // Refuse instead; the caller falls back to serving full size.
    let dir = rel.parent().filter(|d| !d.as_os_str().is_empty())?;
    Some(root.join(dir).join(format!("thumb-{width}")).join(file))
}

/// Decode `jpeg`, downscale to `width` (preserving aspect), re-encode as JPEG.
///
/// CPU-bound, so callers run it on the blocking pool. Frames narrower than `width`
/// are returned untouched rather than upscaled — a smaller file than asked for is
/// always fine for a thumbnail, and re-encoding would only lose quality.
fn render_thumb(jpeg: &[u8], width: u32) -> anyhow::Result<Vec<u8>> {
    use image::codecs::jpeg::JpegEncoder;
    use image::ImageEncoder;

    let img = image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg)?;
    if img.width() <= width {
        return Ok(jpeg.to_vec());
    }
    let height = ((img.height() as u64 * width as u64) / img.width().max(1) as u64).max(1) as u32;
    let small = image::imageops::resize(
        &img.to_rgb8(),
        width,
        height,
        image::imageops::FilterType::Triangle,
    );
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 70).write_image(
        small.as_raw(),
        small.width(),
        small.height(),
        image::ExtendedColorType::Rgb8,
    )?;
    Ok(out)
}

/// Serve a cached thumbnail of `full` at `width`, rendering and caching it on first
/// request. Falls back to the full-size bytes if anything about the render fails —
/// a filmstrip cell showing a heavy image beats one showing an error.
async fn thumb_response(
    root: &std::path::Path,
    blob_ref: &str,
    width: u32,
    full: Vec<u8>,
    lease: &IngestionLease,
) -> Vec<u8> {
    let Some(path) = thumb_path(root, blob_ref, width) else {
        return full;
    };
    let root = root.to_path_buf();
    let full = Arc::new(full);
    let original = full.clone();
    let rendered = match spawn_blocking_ingestion(lease, move || {
        // All filesystem operations own the lease, including cache hits. A
        // cancelled request cannot release it while a cache read is still active.
        if crate::recall::blob_store::check_path(&root, &path, true).is_err() {
            return Ok(original.as_ref().clone());
        }
        if let Ok(cached) = std::fs::read(&path) {
            return Ok(cached);
        }
        let rendered = render_thumb(&original, width)?;
        // Cache creation and writing share the blocking worker's owned lease.
        // Cancelling the HTTP request cannot let deletion overtake either write.
        if let Some(parent) = path.parent() {
            if std::fs::create_dir_all(parent).is_ok() {
                let _ = std::fs::write(&path, &rendered);
            }
        }
        Ok::<_, anyhow::Error>(rendered)
    })
    .await
    {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(e)) => {
            tracing::debug!(error = %e, blob_ref, width, "thumbnail render failed");
            return full.as_ref().clone();
        }
        Err(e) => {
            tracing::warn!(error = %e, "thumbnail render task panicked");
            return full.as_ref().clone();
        }
    };
    rendered
}

#[derive(Debug, Deserialize)]
pub struct BlobQuery {
    /// Requested width in px; snapped to a cacheable bucket. Omitted = full size.
    w: Option<u32>,
}

/// `GET /agents/:id/history/blob/:frame_id?w=` — the JPEG bytes for one frame.
///
/// `w` returns a cached downscale instead of the stored keyframe. The filmstrip,
/// scrubber previews and search results each render dozens of frames at once, and
/// fetching full keyframes for them costs megabytes per interaction.
pub async fn history_blob(
    Path((id, frame_id)): Path<(Uuid, i64)>,
    Query(bq): Query<BlobQuery>,
    State(s): State<Arc<AppState>>,
    RequireOperator(user): RequireOperator,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    // Throttled: one replay row per viewing window, not one per keyframe rendered.
    audit_recall(
        &s,
        &user,
        id,
        AUDIT_REPLAY,
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    // Acquire before the row lookup: after deletion the row is absent, while a
    // request already holding the lease finishes caching before deletion cleans up.
    let lease = Arc::new(s.agents.lifecycle.for_agent(id).read_owned().await);
    let blob_ref = match db::frames::screen_frame_blob_ref(&s.db, id, frame_id).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (StatusCode::NOT_FOUND, "No such frame").into_response();
        }
        Err(e) => return ApiError::from(e).into_response(),
    };

    if crate::recall::blob_store::blob_path(&s.settings.screen_history_dir, id, &blob_ref).is_none()
    {
        return (StatusCode::BAD_REQUEST, "Bad blob reference").into_response();
    }
    let root = s.settings.screen_history_dir.clone();
    let reference = blob_ref.clone();
    // Keep the lifecycle lease in the blocking worker too: request cancellation
    // must not let device deletion overtake a still-running filesystem operation.
    let read = match spawn_blocking_ingestion(&lease, move || {
        crate::recall::blob_store::read_blob(&root, id, &reference)
    })
    .await
    {
        Ok(result) => result,
        Err(e) => return ApiError::Internal(e.into()).into_response(),
    };
    match read {
        Ok(bytes) => {
            let bytes = match bq.w {
                Some(w) => {
                    let width = snap_thumb_width(w);
                    thumb_response(
                        &s.settings.screen_history_dir,
                        &blob_ref,
                        width,
                        bytes,
                        &lease,
                    )
                    .await
                }
                None => bytes,
            };
            (
                [
                    (header::CONTENT_TYPE, "image/jpeg"),
                    (header::CACHE_CONTROL, "private, max-age=86400"),
                ],
                bytes,
            )
                .into_response()
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Only a confirmed missing path under an available, trusted root is
            // orphan evidence. Permission/I/O/path safety errors preserve rows.
            if let Err(e) = db::frames::delete_orphaned_screen_frame(&s.db, id, frame_id).await {
                tracing::warn!(error = %e, %id, frame_id, "failed to delete orphaned screen_frames row");
            }
            (StatusCode::NOT_FOUND, "Frame blob missing").into_response()
        }
        Err(e) => ApiError::Internal(e.into()).into_response(),
    }
}

#[cfg(test)]
#[cfg(test)]
mod thumb_tests {
    use super::*;

    #[tokio::test]
    async fn lifecycle_thumbnail_cache_finishes_before_deletion_cleanup() {
        let root = std::env::temp_dir().join(format!("vantyr-thumb-lifecycle-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let blob_ref = format!("{}/20261003/{}.jpg", Uuid::new_v4(), Uuid::new_v4());
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut jpeg)
            .encode_image(&image::DynamicImage::new_rgb8(32, 16))
            .unwrap();
        let gate = Arc::new(tokio::sync::RwLock::new(()));
        let lease = Arc::new(gate.clone().read_owned().await);
        let mut thumbnail = Box::pin(thumb_response(&root, &blob_ref, 160, jpeg.clone(), &lease));
        assert!(futures_util::poll!(thumbnail.as_mut()).is_pending());
        let deletion_gate = gate.clone();
        let deletion_root = root.clone();
        let mut deletion = Box::pin(async move {
            let _exclusive = deletion_gate.write_owned().await;
            assert!(
                deletion_root.exists(),
                "thumbnail cache must finish before cleanup"
            );
            std::fs::remove_dir_all(deletion_root).unwrap();
        });
        assert!(futures_util::poll!(deletion.as_mut()).is_pending());
        let rendered = thumbnail.as_mut().await;
        assert_eq!(rendered, jpeg);
        assert_eq!(
            std::fs::read(thumb_path(&root, &blob_ref, 160).unwrap()).unwrap(),
            rendered
        );
        drop(thumbnail);
        drop(lease);
        deletion.await;
        assert!(!root.exists());
    }

    #[test]
    fn requested_width_snaps_to_a_cacheable_bucket() {
        assert_eq!(snap_thumb_width(1), 160);
        assert_eq!(snap_thumb_width(173), 160);
        assert_eq!(snap_thumb_width(300), 320);
        assert_eq!(snap_thumb_width(10_000), 640);
    }

    #[test]
    fn thumbs_live_inside_the_frame_day_dir_so_retention_reaps_them() {
        // Retention drops `<root>/<agent>/<YYYYMMDD>/` recursively. If a thumbnail
        // ever escaped that directory it would outlive the frame it renders, and the
        // blob store would grow without bound.
        let root = std::path::Path::new("/blobs");
        let p = thumb_path(root, "agent-a/20260907/frame.jpg", 320).unwrap();
        assert_eq!(
            p,
            std::path::Path::new("/blobs/agent-a/20260907/thumb-320/frame.jpg")
        );
        assert!(p.starts_with(root.join("agent-a").join("20260907")));
    }

    #[test]
    fn a_blob_ref_without_a_directory_yields_no_thumb_path() {
        // Nothing writes refs like this, but falling back to full-size beats
        // writing a thumbnail somewhere retention will never look.
        assert!(thumb_path(std::path::Path::new("/blobs"), "frame.jpg", 160).is_none());
    }
}

#[cfg(test)]
mod tests;
