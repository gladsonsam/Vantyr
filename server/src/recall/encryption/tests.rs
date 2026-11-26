use super::*;

struct TempRoot(PathBuf);
impl TempRoot {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("vantyr-recall-crypto-{}", Uuid::new_v4()));
        private_dirs(&root).unwrap();
        Self(root)
    }
    fn image(&self) -> PathBuf {
        let path = self.0.join(format!(
            "{}/20260101/{}.jpg",
            Uuid::new_v4(),
            Uuid::new_v4()
        ));
        private_dirs(path.parent().unwrap()).unwrap();
        path
    }
}
impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
const JPEG: &[u8] = b"\xff\xd8private-image\xff\xd9";

#[test]
fn recall_encryption_roundtrip_random_nonce_and_path_binding() {
    let id = Uuid::new_v4();
    let keys = test_keyring(id, 1);
    let reference = format!("{}/20260101/{}.jpg", Uuid::new_v4(), Uuid::new_v4());
    let first = keys.encrypt(&reference, JPEG).unwrap();
    let second = keys.encrypt(&reference, JPEG).unwrap();
    assert_ne!(&first[HEADER - 12..HEADER], &second[HEADER - 12..HEADER]);
    assert_eq!(envelope_key(&first).unwrap(), id);
    assert!(!first.windows(JPEG.len()).any(|window| window == JPEG));
    assert_eq!(keys.decrypt(&reference, first.clone()).unwrap(), JPEG);
    for wrong in ["wrong agent", "wrong frame", "thumb-160/wrong frame"] {
        assert!(keys.decrypt(wrong, first.clone()).is_err());
    }
    assert!(test_keyring(id, 2)
        .decrypt(&reference, first.clone())
        .is_err());
    assert!(test_keyring(Uuid::new_v4(), 1)
        .decrypt(&reference, first.clone())
        .is_err());
    assert!(decode(None, &reference, first.clone()).is_err());
    assert!(decode(Some(&keys), &reference, JPEG.to_vec()).is_err());
    for index in [
        0,
        MAGIC.len(),
        MAGIC.len() + 1,
        HEADER - 1,
        HEADER,
        first.len() - 1,
    ] {
        let mut corrupt = first.clone();
        corrupt[index] ^= 1;
        assert!(
            keys.decrypt(&reference, corrupt).is_err(),
            "tampering at byte {index}"
        );
    }
    assert!(keys.decrypt(&reference, first[..HEADER].to_vec()).is_err());
}

#[test]
fn recall_encryption_keygen_is_private_non_overwriting_and_versioned() {
    let root = TempRoot::new();
    let path = root.0.join("keyring.json");
    generate(&path).unwrap();
    let first = fs::read(&path).unwrap();
    assert!(generate(&path).is_err());
    assert_eq!(fs::read(&path).unwrap(), first);
    let keys = Keyring::load(&path).unwrap();
    assert_eq!(
        keys.decrypt("a", keys.encrypt("a", JPEG).unwrap()).unwrap(),
        JPEG
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
        assert!(Keyring::load(&path).is_ok());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(Keyring::load(&path).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let mut wrong_version: serde_json::Value = serde_json::from_slice(&first).unwrap();
    wrong_version["version"] = 99.into();
    fs::write(&path, serde_json::to_vec(&wrong_version).unwrap()).unwrap();
    assert!(Keyring::load(&path).is_err());
}

#[test]
fn recall_encryption_startup_rejects_absent_wrong_and_incomplete_keys() {
    let root = TempRoot::new();
    let id = Uuid::new_v4();
    let keys = test_keyring(id, 3);
    let guard = lock(&root.0).unwrap();
    assert!(
        lock(&root.0).is_err(),
        "offline migration cannot overlap server"
    );
    validate_startup(&root.0, Some(&keys)).unwrap();
    assert!(validate_startup(&root.0, None).is_err());
    assert!(validate_startup(&root.0, Some(&test_keyring(id, 4))).is_err());
    assert!(validate_startup(&root.0, Some(&test_keyring(Uuid::new_v4(), 3))).is_err());
    write_marker(&root.0, &keys, PENDING).unwrap();
    assert!(validate_startup(&root.0, Some(&keys)).is_err());
    write_marker(&root.0, &keys, READY).unwrap();
    validate_startup(&root.0, Some(&keys)).unwrap();
    let image = root.image();
    atomic_write(
        &image,
        &keys
            .encrypt(&relative(&root.0, &image).unwrap(), JPEG)
            .unwrap(),
    )
    .unwrap();
    fs::remove_file(root.0.join(MARKER)).unwrap();
    assert!(validate_startup(&root.0, None).is_err());
    assert!(validate_startup(&root.0, Some(&keys)).is_err());
    drop(guard);
    assert!(lock(&root.0).is_ok());
}

#[test]
fn recall_encryption_migration_dry_run_preflight_resume_and_rotation() {
    let root = TempRoot::new();
    let old = Uuid::new_v4();
    let keys = test_keyring(old, 5);
    let image = root.image();
    let thumb = image
        .parent()
        .unwrap()
        .join("thumb-320")
        .join(image.file_name().unwrap());
    private_dirs(thumb.parent().unwrap()).unwrap();
    for path in [&image, &thumb] {
        fs::write(path, JPEG).unwrap();
    }
    assert!(validate_startup(&root.0, Some(&keys)).is_err());
    assert_eq!(migrate(&root.0, &keys, false).unwrap().plaintext, 2);
    assert!(!root.0.join(MARKER).exists());
    assert_eq!(fs::read(&image).unwrap(), JPEG);

    // Simulate a crash after the pending marker and one completed replacement,
    // with a partially written temporary file beside the still-intact original.
    write_marker(&root.0, &keys, PENDING).unwrap();
    atomic_write(
        &image,
        &keys
            .encrypt(&relative(&root.0, &image).unwrap(), JPEG)
            .unwrap(),
    )
    .unwrap();
    let temp = thumb.with_file_name(format!(
        ".recall-tmp-{}-{}",
        Uuid::new_v4(),
        thumb.file_name().unwrap().to_str().unwrap()
    ));
    fs::write(&temp, b"partial").unwrap();
    let report = migrate(&root.0, &keys, false).unwrap();
    assert_eq!(
        (report.plaintext, report.current, report.interrupted_temps),
        (1, 1, 1)
    );
    assert_eq!(fs::read(&thumb).unwrap(), JPEG);
    assert!(temp.exists());
    migrate(&root.0, &keys, true).unwrap();
    assert!(!temp.exists());
    validate_startup(&root.0, Some(&keys)).unwrap();
    for path in [&image, &thumb] {
        assert_eq!(
            keys.decrypt(&relative(&root.0, path).unwrap(), fs::read(path).unwrap())
                .unwrap(),
            JPEG
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    assert_eq!(migrate(&root.0, &keys, false).unwrap().current, 2);

    let new = Uuid::new_v4();
    let rotated = Keyring {
        active: new,
        keys: HashMap::from([
            (
                old,
                LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &[5; 32]).unwrap()),
            ),
            (
                new,
                LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &[6; 32]).unwrap()),
            ),
        ]),
    };
    assert!(validate_startup(&root.0, Some(&rotated)).is_err());
    assert_eq!(migrate(&root.0, &rotated, false).unwrap().rekey, 2);
    assert!(migrate(&root.0, &test_keyring(new, 6), true).is_err());
    migrate(&root.0, &rotated, true).unwrap();
    let only_new = test_keyring(new, 6);
    validate_startup(&root.0, Some(&only_new)).unwrap();
    for path in [&image, &thumb] {
        assert_eq!(
            only_new
                .decrypt(&relative(&root.0, path).unwrap(), fs::read(path).unwrap())
                .unwrap(),
            JPEG
        );
    }
}

#[test]
fn recall_encryption_migration_preserves_originals_on_failed_preflight() {
    let root = TempRoot::new();
    let keys = test_keyring(Uuid::new_v4(), 7);
    let image = root.image();
    let bad = root.image();
    fs::write(&image, JPEG).unwrap();
    let mut tampered = keys
        .encrypt(&relative(&root.0, &bad).unwrap(), JPEG)
        .unwrap();
    *tampered.last_mut().unwrap() ^= 1;
    fs::write(&bad, &tampered).unwrap();
    assert!(migrate(&root.0, &keys, true).is_err());
    assert_eq!(fs::read(&image).unwrap(), JPEG);
    assert_eq!(fs::read(&bad).unwrap(), tampered);
    assert!(!root.0.join(MARKER).exists());

    // Force rename failure. Neither the destination directory nor its
    // contents are replaced, and the failed temp is cleaned up.
    let target = root.0.join("existing-dir");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("keep"), JPEG).unwrap();
    assert!(atomic_write(&target, b"replacement").is_err());
    assert_eq!(fs::read(target.join("keep")).unwrap(), JPEG);
    assert!(fs::read_dir(&root.0).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".recall-tmp-")));
}
