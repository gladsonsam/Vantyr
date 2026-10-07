use super::*;
use crate::recall_context::test_support::fixture;

async fn request(s: Arc<AppState>, id: Uuid, frame: i64) -> Response {
    request_width(s, id, frame, None).await
}
async fn request_width(s: Arc<AppState>, id: Uuid, frame: i64, width: Option<u32>) -> Response {
    history_blob(
        Path((id, frame)),
        Query(BlobQuery { w: width }),
        State(s),
        RequireOperator(crate::state::agent_lifecycle::test_support::admin()),
        HeaderMap::new(),
        ConnectInfo("127.0.0.1:1234".parse().unwrap()),
    )
    .await
}
async fn add(s: &AppState, id: Uuid, reference: &str) -> i64 {
    db::insert_screen_frame(
        &s.db,
        id,
        Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap(),
        0,
        10,
        10,
        0,
        reference,
        None,
        None,
        None,
        &crate::recall_context::Metadata::default(),
    )
    .await
    .unwrap()
    .unwrap()
}
async fn present(s: &AppState, id: Uuid, frame: i64) -> bool {
    db::screen_frame_blob_ref(&s.db, id, frame)
        .await
        .unwrap()
        .is_some()
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; temporary PostgreSQL/filesystem fixtures only"]
async fn blob_errors_preserve_rows_missing_files_heal_and_available_reads_preserve_bytes() {
    let (s, id, _, _) = fixture().await;
    let reference = format!("{id}/20260101/{}.jpg", Uuid::new_v4());
    let frame = add(&s, id, &reference).await;
    assert!(!s.settings.screen_history_dir.exists());
    assert_eq!(
        request(s.clone(), id, frame).await.status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert!(
        present(&s, id, frame).await,
        "unavailable root must not erase retained rows"
    );
    let path = s.settings.screen_history_dir.join(&reference);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::create_dir(&path).unwrap(); // deterministic non-missing filesystem error
    assert_eq!(
        request(s.clone(), id, frame).await.status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert!(present(&s, id, frame).await);
    std::fs::remove_dir(&path).unwrap();
    let jpeg = b"\xff\xd8original-jpeg\xff\xd9";
    std::fs::write(&path, jpeg).unwrap();
    let response = request(s.clone(), id, frame).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap()
            .as_ref(),
        jpeg
    );
    assert!(present(&s, id, frame).await);
    std::fs::remove_file(&path).unwrap();
    assert_eq!(
        request(s.clone(), id, frame).await.status(),
        StatusCode::NOT_FOUND
    );
    assert!(!present(&s, id, frame).await);
    // The row lookup is still strictly scoped to the requested device.
    let another = add(&s, id, &reference).await;
    assert_eq!(
        request(s.clone(), Uuid::new_v4(), another).await.status(),
        StatusCode::NOT_FOUND
    );
    assert!(present(&s, id, another).await);
    std::fs::remove_dir_all(&s.settings.screen_history_dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; temporary PostgreSQL/filesystem fixtures only"]
async fn traversal_and_symlinks_never_read_or_delete_external_files_or_rows() {
    use std::os::unix::fs::symlink;
    let (s, id, _, _) = fixture().await;
    let outside = std::env::temp_dir().join(format!("vantyr-external-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("private.jpg"), b"private").unwrap();
    std::fs::create_dir_all(&s.settings.screen_history_dir).unwrap();
    let invalid = format!("{id}/20260101/../../private.jpg");
    let frame = add(&s, id, &invalid).await;
    assert_eq!(
        request(s.clone(), id, frame).await.status(),
        StatusCode::BAD_REQUEST
    );
    assert!(present(&s, id, frame).await);
    let reference = format!("{id}/20260101/{}.jpg", Uuid::new_v4());
    let frame = add(&s, id, &reference).await;
    let agent_dir = s.settings.screen_history_dir.join(id.to_string());
    symlink(&outside, &agent_dir).unwrap();
    assert_eq!(
        request(s.clone(), id, frame).await.status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert!(present(&s, id, frame).await);
    std::fs::remove_file(&agent_dir).unwrap();
    std::fs::create_dir_all(&agent_dir).unwrap();
    let day = agent_dir.join("20260101");
    symlink(&outside, &day).unwrap();
    assert_eq!(
        request(s.clone(), id, frame).await.status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert!(present(&s, id, frame).await);
    std::fs::remove_file(&day).unwrap();
    std::fs::create_dir_all(&day).unwrap();
    let path = s.settings.screen_history_dir.join(&reference);
    symlink(outside.join("private.jpg"), &path).unwrap();
    assert_eq!(
        request(s.clone(), id, frame).await.status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert!(present(&s, id, frame).await);
    std::fs::remove_file(&path).unwrap();
    std::fs::write(&path, b"original").unwrap();
    let cache = day.join("thumb-160");
    symlink(&outside, &cache).unwrap();
    let response = request_width(s.clone(), id, frame, Some(160)).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap()
            .as_ref(),
        b"original"
    );
    assert_eq!(
        std::fs::read_dir(&outside).unwrap().count(),
        1,
        "unsafe cache directory must receive no new files"
    );
    std::fs::remove_file(&cache).unwrap();
    std::fs::create_dir(&cache).unwrap();
    let cache_file = cache.join(path.file_name().unwrap());
    symlink(outside.join("private.jpg"), &cache_file).unwrap();
    let response = request_width(s.clone(), id, frame, Some(160)).await;
    assert_eq!(
        axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap()
            .as_ref(),
        b"original"
    );
    assert_eq!(
        std::fs::read(outside.join("private.jpg")).unwrap(),
        b"private"
    );
    std::fs::remove_dir_all(&s.settings.screen_history_dir).unwrap();
    std::fs::remove_dir_all(outside).unwrap();
}

#[test]
fn generated_blob_path_rejects_absolute_wrong_device_invalid_dates_and_extra_components() {
    let id = Uuid::new_v4();
    let filename = format!("{}.jpg", Uuid::new_v4());
    let root = std::path::Path::new("/temporary/fixture");
    assert!(
        crate::recall_blob::blob_path(root, id, &format!("{id}/20260101/{filename}")).is_some()
    );
    for value in [
        format!("/{id}/20260101/{filename}"),
        format!("{id}/20260230/{filename}"),
        format!("{id}//20260101/{filename}"),
        format!("{}/20260101/{filename}", Uuid::new_v4()),
        format!("{id}/20260101/{filename}/extra"),
        format!("{id}/20260101/arbitrary.jpg"),
    ] {
        assert!(
            crate::recall_blob::blob_path(root, id, &value).is_none(),
            "{value}"
        );
    }
}

#[test]
fn unavailable_root_is_not_a_missing_frame() {
    let id = Uuid::new_v4();
    let reference = format!("{id}/20260101/{}.jpg", Uuid::new_v4());
    let root = std::env::temp_dir().join(format!("vantyr-blob-errors-{}", Uuid::new_v4()));
    assert_eq!(
        crate::recall_blob::read_blob(&root, id, &reference)
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::Other
    );
    std::fs::create_dir(&root).unwrap();
    assert_eq!(
        crate::recall_blob::read_blob(&root, id, &reference)
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::NotFound
    );
    std::fs::remove_dir(&root).unwrap();
}

#[tokio::test]
async fn thumbnail_render_error_returns_already_read_original_without_reading_again() {
    let root = std::env::temp_dir().join(format!("vantyr-thumb-fallback-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let reference = format!("{}/20260101/{}.jpg", Uuid::new_v4(), Uuid::new_v4());
    let original = b"stored bytes that cannot decode as JPEG".to_vec();
    let gate = Arc::new(tokio::sync::RwLock::new(()));
    let lease = Arc::new(gate.read_owned().await);
    assert_eq!(
        thumb_response(&root, &reference, 160, original.clone(), &lease).await,
        original,
        "fallback must preserve original bytes even if the source is no longer present"
    );
    assert!(!root.join(&reference).exists());
    assert!(!thumb_path(&root, &reference, 160).unwrap().exists());
    std::fs::remove_dir(&root).unwrap();
}
