//! Pixel helpers for the keyframe pipeline: perceptual hash for dedup, downscale, JPEG encode.

use image::{
    codecs::jpeg::JpegEncoder, imageops::FilterType, ExtendedColorType, ImageEncoder, RgbaImage,
};

/// 64-bit average-hash (aHash): downscale to 8×8, grayscale, threshold at mean.
/// Cheap, allocation-light, and good enough to tell "screen changed" from noise.
pub(super) fn average_hash(img: &RgbaImage) -> u64 {
    let small = image::imageops::resize(img, 8, 8, FilterType::Triangle);
    let mut lumas = [0u16; 64];
    let mut sum: u32 = 0;
    for (i, px) in small.pixels().enumerate() {
        let [r, g, b, _] = px.0;
        // Integer Rec.601 luma.
        let l = (r as u32 * 299 + g as u32 * 587 + b as u32 * 114) / 1000;
        lumas[i] = l as u16;
        sum += l;
    }
    let mean = (sum / 64) as u16;
    let mut hash = 0u64;
    for (i, &l) in lumas.iter().enumerate() {
        if l >= mean {
            hash |= 1u64 << i;
        }
    }
    hash
}

#[inline]
pub(super) fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// Downscale so the longest edge is at most `max_dim`, preserving aspect ratio.
pub(super) fn downscale(img: RgbaImage, max_dim: u32) -> RgbaImage {
    if max_dim == 0 {
        return img;
    }
    let (w, h) = (img.width(), img.height());
    let longest = w.max(h);
    if longest <= max_dim {
        return img;
    }
    let scale = max_dim as f32 / longest as f32;
    let nw = ((w as f32 * scale).round() as u32).max(1);
    let nh = ((h as f32 * scale).round() as u32).max(1);
    image::imageops::resize(&img, nw, nh, FilterType::Triangle)
}

pub(super) fn encode_jpeg(img: &RgbaImage, quality: u8) -> anyhow::Result<Vec<u8>> {
    let rgb = image::DynamicImage::ImageRgba8(img.clone()).into_rgb8();
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, quality).write_image(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        ExtendedColorType::Rgb8,
    )?;
    Ok(out)
}
