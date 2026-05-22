//! Derive a "friendly" display name for a process from its version resources.
//!
//! We store both:
//! - the raw executable basename (e.g. `msedge.exe`) for matching/filtering
//! - the friendly display name (e.g. `Microsoft Edge`) for UI
//!
//! This module is best-effort: it falls back to the executable basename when
//! version metadata isn't available.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use windows::core::PCWSTR;
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;

static APP_DISPLAY_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, String>> {
    APP_DISPLAY_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn exe_basename_from_full_path(full_path: &str) -> String {
    full_path
        .trim_matches('"')
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .to_string()
}

fn normalize_display_name(mut s: String) -> String {
    s = s.trim_matches('\u{0}').trim().to_string();
    if s.is_empty() {
        return s;
    }

    // If the metadata returns something like `chrome.exe`, trim the extension
    // so it reads better as a "name".
    let lower = s.to_ascii_lowercase();
    if lower.ends_with(".exe") && s.len() > 4 {
        s.truncate(s.len() - 4);
    }

    s
}

fn to_wide_null(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

unsafe fn query_string_from_version_block(version_block: &[u8], sub_block: &str) -> Option<String> {
    let sub_block_w = to_wide_null(sub_block);
    let mut lp_buffer: *mut c_void = std::ptr::null_mut();
    let mut out_len: u32 = 0;

    let ok = VerQueryValueW(
        version_block.as_ptr().cast::<c_void>(),
        PCWSTR(sub_block_w.as_ptr()),
        &raw mut lp_buffer,
        &raw mut out_len,
    )
    .as_bool();

    if !ok || lp_buffer.is_null() {
        return None;
    }

    // For `VerQueryValueW` string sub-blocks, `out_len` is typically the length
    // in UTF-16 characters (often including the trailing NUL). Other queries
    // (like Translation) use byte lengths, but those are handled elsewhere.
    //
    // Treat `out_len` as an upper bound in u16s, clamp aggressively, and stop
    // on NUL to avoid over-reading even if a platform/driver misreports.
    let max_chars = (out_len as usize).clamp(1, 2048);

    let pw = lp_buffer as *const u16;
    let mut end = 0usize;
    while end < max_chars && *pw.add(end) != 0 {
        end += 1;
    }
    if end == 0 {
        return None;
    }

    let slice = std::slice::from_raw_parts(pw, end);
    Some(String::from_utf16_lossy(slice))
}

unsafe fn query_translations(version_block: &[u8]) -> Option<Vec<(u16, u16)>> {
    let query = r"\VarFileInfo\Translation";
    let query_w = to_wide_null(query);
    let mut lp_buffer: *mut c_void = std::ptr::null_mut();
    let mut out_len: u32 = 0;

    let ok = VerQueryValueW(
        version_block.as_ptr().cast::<c_void>(),
        PCWSTR(query_w.as_ptr()),
        &raw mut lp_buffer,
        &raw mut out_len,
    )
    .as_bool();

    if !ok || lp_buffer.is_null() || out_len == 0 {
        return None;
    }

    // LANGANDCODEPAGE is 4 bytes: (u16 language, u16 codepage)
    let count = (out_len as usize) / 4;
    if count == 0 {
        return None;
    }

    let p = lp_buffer as *const u16;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let lang = *p.add(i * 2);
        let codepage = *p.add(i * 2 + 1);
        out.push((lang, codepage));
    }
    Some(out)
}

fn app_display_from_full_path_uncached(full_path: &str) -> String {
    let trimmed = full_path.trim_matches('"');
    let exe = exe_basename_from_full_path(trimmed);
    if exe.is_empty() {
        return String::new();
    }

    let file_path_w = to_wide_null(trimmed);
    unsafe {
        let size = GetFileVersionInfoSizeW(PCWSTR(file_path_w.as_ptr()), None);
        if size == 0 {
            return exe;
        }

        let mut buf = vec![0u8; size as usize];
        let ok = GetFileVersionInfoW(
            PCWSTR(file_path_w.as_ptr()),
            Some(0),
            size,
            buf.as_mut_ptr().cast::<c_void>(),
        )
        .is_ok();

        if !ok {
            return exe;
        }

        let translations = query_translations(&buf).unwrap_or_else(|| vec![(0x0409u16, 0x04B0u16)]); // en-US fallback

        // Try a few likely metadata fields, in order.
        //
        // Important: `ProductName` is often the OS name for Windows components
        // (e.g. `ApplicationFrameHost.exe`, `explorer.exe`) which makes the UI
        // misleading. Prefer `FileDescription` first; it usually contains the
        // actual component/app name users expect.
        for (lang, codepage) in translations {
            let desc_q = format!(r"\StringFileInfo\{lang:04x}{codepage:04x}\FileDescription");
            if let Some(v) = query_string_from_version_block(&buf, &desc_q) {
                let v = normalize_display_name(v);
                if !v.is_empty() {
                    return v;
                }
            }

            let product_q = format!(r"\StringFileInfo\{lang:04x}{codepage:04x}\ProductName");
            if let Some(v) = query_string_from_version_block(&buf, &product_q) {
                let v = normalize_display_name(v);
                if !v.is_empty() {
                    return v;
                }
            }

            let orig_q = format!(r"\StringFileInfo\{lang:04x}{codepage:04x}\OriginalFilename");
            if let Some(v) = query_string_from_version_block(&buf, &orig_q) {
                let v = normalize_display_name(v);
                if !v.is_empty() {
                    return v;
                }
            }
        }
    }

    exe
}

/// Best-effort friendly display name for the process at `full_path`.
///
/// Always returns something (at minimum the executable basename).
pub fn app_display_name_from_full_path(full_path: &str) -> String {
    let trimmed = full_path.trim_matches('"');
    if trimmed.is_empty() {
        return String::new();
    }

    let key = trimmed.to_ascii_lowercase();

    if let Some(v) = cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        return v;
    }

    let computed = app_display_from_full_path_uncached(trimmed);
    if let Ok(mut c) = cache().lock() {
        c.insert(key, computed.clone());
    }
    computed
}
