//! Windows executable icon extraction (PNG).
//!
//! Best-effort: if anything fails, callers can treat icons as optional.

use anyhow::{Context, Result};

#[cfg(target_os = "windows")]
pub fn icon_png_from_exe_path(exe_path: &str, size_px: u32) -> Result<Vec<u8>> {
    use image::{codecs::png::PngEncoder, ColorType, ImageEncoder};
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, SelectObject, BITMAP,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
    };
    use windows::Win32::UI::Shell::ExtractIconExW;
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    if exe_path.trim().is_empty() {
        anyhow::bail!("empty exe path");
    }

    // Convert path to wide string
    let wide: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();

    // Extract a large icon handle.
    let mut large: [HICON; 1] = [HICON::default()];
    let mut small: [HICON; 1] = [HICON::default()];
    let n = unsafe {
        ExtractIconExW(
            PCWSTR(wide.as_ptr()),
            0,
            Some(large.as_mut_ptr()),
            Some(small.as_mut_ptr()),
            1,
        )
    };
    if n == 0 || large[0].0.is_null() {
        // Try small if large failed.
        if small[0].0.is_null() {
            anyhow::bail!("no icon extracted");
        }
        large[0] = small[0];
    } else {
        // Clean up small if we didn't use it.
        if !small[0].0.is_null() {
            unsafe {
                let _ = DestroyIcon(small[0]);
            }
        }
    }
    let hicon = large[0];

    // Get HBITMAP (color) for the icon.
    let mut iconinfo = ICONINFO::default();
    unsafe {
        GetIconInfo(hicon, &raw mut iconinfo)
            .ok()
            .context("GetIconInfo failed")?;
    };
    let hbm_color: HBITMAP = iconinfo.hbmColor;
    let hbm_mask: HBITMAP = iconinfo.hbmMask;

    // Read bitmap dimensions.
    let mut bmp = BITMAP::default();
    let got = unsafe {
        GetObjectW(
            hbm_color.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some((&raw mut bmp).cast()),
        )
    };
    if got == 0 {
        unsafe {
            if !hbm_color.0.is_null() {
                let _ = DeleteObject(hbm_color.into());
            }
            if !hbm_mask.0.is_null() {
                let _ = DeleteObject(hbm_mask.into());
            }
            let _ = DestroyIcon(hicon);
        }
        anyhow::bail!("GetObjectW failed");
    }

    let width = bmp.bmWidth.max(1);
    let height = bmp.bmHeight.abs().max(1);

    // Prepare BITMAPINFO for 32-bit BGRA.
    let mut bi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        bmiColors: [Default::default(); 1],
    };

    let mut buf = vec![0u8; (width as usize) * (height as usize) * 4];
    let hdc = unsafe { CreateCompatibleDC(None) };
    if hdc.0.is_null() {
        unsafe {
            if !hbm_color.0.is_null() {
                let _ = DeleteObject(hbm_color.into());
            }
            if !hbm_mask.0.is_null() {
                let _ = DeleteObject(hbm_mask.into());
            }
            let _ = DestroyIcon(hicon);
        }
        anyhow::bail!("CreateCompatibleDC failed");
    }
    let old = unsafe { SelectObject(hdc, hbm_color.into()) };
    let scanlines = unsafe {
        GetDIBits(
            hdc,
            hbm_color,
            0,
            height as u32,
            Some(buf.as_mut_ptr().cast()),
            &raw mut bi,
            DIB_RGB_COLORS,
        )
    };
    // Restore selection + cleanup DC.
    unsafe {
        let _ = SelectObject(hdc, old);
        let _ = DeleteDC(hdc);
    }

    if scanlines == 0 {
        unsafe {
            if !hbm_color.0.is_null() {
                let _ = DeleteObject(hbm_color.into());
            }
            if !hbm_mask.0.is_null() {
                let _ = DeleteObject(hbm_mask.into());
            }
            let _ = DestroyIcon(hicon);
        }
        anyhow::bail!("GetDIBits returned 0");
    }

    // Cleanup GDI objects and icon.
    unsafe {
        if !hbm_color.0.is_null() {
            let _ = DeleteObject(hbm_color.into());
        }
        if !hbm_mask.0.is_null() {
            let _ = DeleteObject(hbm_mask.into());
        }
        let _ = DestroyIcon(hicon);
    }

    // Convert BGRA -> RGBA
    for px in buf.chunks_exact_mut(4) {
        let b = px[0];
        let r = px[2];
        px[0] = r;
        px[2] = b;
    }

    // Optionally downscale to requested size (keeps payload bounded).
    let (out_w, out_h, out_rgba) =
        if size_px > 0 && (width as u32 != size_px || height as u32 != size_px) {
            let img = image::RgbaImage::from_raw(width as u32, height as u32, buf)
                .context("RgbaImage::from_raw failed")?;
            let resized = image::imageops::resize(
                &img,
                size_px,
                size_px,
                image::imageops::FilterType::Triangle,
            );
            (resized.width(), resized.height(), resized.into_raw())
        } else {
            (width as u32, height as u32, buf)
        };

    let mut out = Vec::new();
    let enc = PngEncoder::new(&mut out);
    enc.write_image(&out_rgba, out_w, out_h, ColorType::Rgba8.into())
        .context("PNG encode failed")?;
    Ok(out)
}

/// PNG bytes for the Vantyr agent tile (from the bundled `icons/icon.ico`).
///
/// Windows often fails to extract an icon from our own EXE via `ExtractIconExW`
/// even when the installer icon looks fine; the dashboard loads icons from uploaded PNGs.
#[cfg(target_os = "windows")]
pub fn vantyr_brand_icon_png() -> Result<Vec<u8>> {
    use image::codecs::png::PngEncoder;
    use image::{ColorType, ImageEncoder};

    const ICO_BYTES: &[u8] = include_bytes!("../icons/icon.ico");
    let img = image::load_from_memory(ICO_BYTES).context("decode embedded icons/icon.ico")?;
    let rgba = img
        .resize_exact(64, 64, image::imageops::FilterType::Triangle)
        .to_rgba8();
    let mut out = Vec::new();
    PngEncoder::new(&mut out)
        .write_image(
            rgba.as_raw(),
            rgba.width(),
            rgba.height(),
            ColorType::Rgba8.into(),
        )
        .context("encode vantyr brand PNG")?;
    Ok(out)
}

#[cfg(target_os = "windows")]
pub fn is_current_process_exe(image_path: &str) -> bool {
    let path = image_path.trim();
    if path.is_empty() {
        return false;
    }
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let Ok(want) = std::fs::canonicalize(path) else {
        return false;
    };
    let Ok(have) = std::fs::canonicalize(exe) else {
        return false;
    };
    want == have
}

#[cfg(not(target_os = "windows"))]
pub fn icon_png_from_exe_path(_exe_path: &str, _size_px: u32) -> Result<Vec<u8>> {
    anyhow::bail!("icons are only supported on Windows")
}

#[cfg(not(target_os = "windows"))]
pub fn vantyr_brand_icon_png() -> Result<Vec<u8>> {
    anyhow::bail!("icons are only supported on Windows")
}

#[cfg(not(target_os = "windows"))]
pub fn is_current_process_exe(_image_path: &str) -> bool {
    false
}
