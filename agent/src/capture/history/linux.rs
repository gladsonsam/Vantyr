//! Linux screen-history OCR: not implemented yet (a later phase can wire
//! Tesseract), so frames carry no text.

use image::RgbaImage;

use super::OcrOutput;

/// No OCR engine on Linux yet; returns empty output.
pub(super) fn ocr_rgba(_img: &RgbaImage) -> anyhow::Result<OcrOutput> {
    Ok(OcrOutput::default())
}
