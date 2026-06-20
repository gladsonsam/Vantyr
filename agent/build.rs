fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        build_tauri();
    }
}

#[cfg(windows)]
fn build_tauri() {
    tauri_build::build();
}

#[cfg(not(windows))]
fn build_tauri() {}
