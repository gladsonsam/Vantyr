use super::*;

#[test]
fn removes_only_the_requested_uuid_directory() {
    let root = std::env::temp_dir().join(format!("vantyr-removal-{}", Uuid::new_v4()));
    let agent = Uuid::new_v4();
    let other = Uuid::new_v4();
    for id in [agent, other] {
        std::fs::create_dir_all(root.join(id.to_string()).join("20261003")).unwrap();
        std::fs::write(
            root.join(id.to_string()).join("20261003/frame.jpg"),
            b"jpeg",
        )
        .unwrap();
    }
    remove_agent_screen_blobs(&root, agent).unwrap();
    remove_agent_screen_blobs(&root, agent).unwrap(); // idempotent
    assert!(!root.join(agent.to_string()).exists());
    assert!(root
        .join(other.to_string())
        .join("20261003/frame.jpg")
        .exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn refuses_symlink_and_preserves_external_target() {
    let root = std::env::temp_dir().join(format!("vantyr-symlink-{}", Uuid::new_v4()));
    let external = root.join("external");
    std::fs::create_dir_all(&external).unwrap();
    std::fs::write(external.join("keep.jpg"), b"jpeg").unwrap();
    let agent = Uuid::new_v4();
    std::os::unix::fs::symlink(&external, root.join(agent.to_string())).unwrap();
    assert!(remove_agent_screen_blobs(&root, agent).is_err());
    assert!(external.join("keep.jpg").exists());
    std::fs::remove_dir_all(root).unwrap();
}
