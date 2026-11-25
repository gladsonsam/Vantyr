fn main() {
    let target = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let include_paths = if target == "windows" {
        windows_libs()
    } else {
        unix_libs()
    };
    let mut b = bindgen::Builder::default()
        .header_contents("wrap.h", "#include <stdint.h>\n#include <x264.h>\n")
        .allowlist_function("x264_.*")
        .allowlist_type("x264_.*")
        .allowlist_var("X264_.*")
        .layout_tests(false);
    for p in &include_paths {
        b = b.clang_arg(format!("-I{}", p.display()));
    }
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let mut code = b.generate().expect("bindgen x264").to_string();
    // x264.h renames x264_encoder_open after the library's build number (a macro
    // bindgen can't follow); alias whichever version this x264 has.
    let open = code
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .find(|w| {
            w.strip_prefix("x264_encoder_open_")
                .is_some_and(|n| n.chars().all(|c| c.is_ascii_digit()))
        })
        .expect("x264_encoder_open_<build> in x264.h")
        .to_string();
    code.push_str(&format!("\npub use {open} as x264_encoder_open;\n"));
    std::fs::write(out.join("x264.rs"), code).unwrap();

    println!("cargo:rerun-if-changed=build.rs");
}

/// Native x264 and libyuv, discovered with pkg-config.
fn unix_libs() -> Vec<std::path::PathBuf> {
    let x264 = pkg_config::probe_library("x264").expect("install libx264-dev (see BUILD.md)");
    if pkg_config::probe_library("libyuv").is_err() {
        // Debian/Arch libyuv installs no pkg-config file.
        println!("cargo:rustc-link-lib=yuv");
    }
    x264.include_paths
}

/// Static MSVC native codecs from vcpkg. No codec server or web bundler runs.
fn windows_libs() -> Vec<std::path::PathBuf> {
    let x264 = vcpkg::Config::new()
        .find_package("x264")
        .expect("x264 from vcpkg");
    vcpkg::Config::new()
        .find_package("libyuv")
        .expect("libyuv from vcpkg");
    println!("cargo:rerun-if-env-changed=VCPKGRS_TRIPLET");
    x264.include_paths
}
