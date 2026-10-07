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

#[cfg(test)]
mod tests {
    use image::Rgba;

    use super::*;

    /// Black on the left half, white on the right half.
    fn split_image(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, _| {
            if x < w / 2 {
                Rgba([0, 0, 0, 255])
            } else {
                Rgba([255, 255, 255, 255])
            }
        })
    }

    #[test]
    fn hamming_counts_differing_bits() {
        assert_eq!(hamming(0, 0), 0);
        assert_eq!(hamming(0b1010, 0b0110), 2);
        assert_eq!(hamming(u64::MAX, 0), 64);
    }

    #[test]
    fn average_hash_is_stable_and_tells_different_screens_apart() {
        let a = split_image(64, 64);
        assert_eq!(average_hash(&a), average_hash(&a.clone()));
        // The same layout at another resolution hashes the same.
        assert_eq!(average_hash(&a), average_hash(&split_image(128, 128)));
        // Mirroring the screen flips the bright half, so most bits differ.
        let mirrored = image::imageops::flip_horizontal(&a);
        assert!(hamming(average_hash(&a), average_hash(&mirrored)) >= 32);
    }

    #[test]
    fn downscale_keeps_the_aspect_ratio_and_never_upscales() {
        let img = split_image(400, 200);
        let small = downscale(img.clone(), 100);
        assert_eq!((small.width(), small.height()), (100, 50));
        let same = downscale(img.clone(), 400);
        assert_eq!((same.width(), same.height()), (400, 200));
        let zero = downscale(img, 0);
        assert_eq!((zero.width(), zero.height()), (400, 200));
        // A very thin image keeps at least one pixel on the short edge.
        let thin = downscale(split_image(1000, 2), 10);
        assert_eq!((thin.width(), thin.height()), (10, 1));
    }

    #[test]
    fn encode_jpeg_produces_a_jpeg() {
        let jpeg = encode_jpeg(&split_image(32, 32), 60).unwrap();
        assert!(jpeg.starts_with(&[0xff, 0xd8]));
        assert!(jpeg.ends_with(&[0xff, 0xd9]));
    }
}
