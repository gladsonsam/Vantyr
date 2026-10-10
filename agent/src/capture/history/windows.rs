//! Windows screen-history OCR via the native `Windows.Media.Ocr` engine.

use std::time::Duration;

use image::RgbaImage;

use super::{OcrOutput, OcrWord};

/// Cap on stored word boxes per frame. A dense page of text runs to a few hundred
/// words; this bounds the payload for pathological screens (a wall of logs) without
/// truncating anything realistic.
const MAX_OCR_WORDS: usize = 1_500;

/// Extract text from a frame using the OS OCR engine. Windows uses the native
/// `Windows.Media.Ocr` engine (no model download, runs offline). Other platforms
/// return empty output for now (a later phase can wire Tesseract on Linux).
///
/// Word geometry is kept, not just the concatenated text: it is what lets the
/// dashboard lay invisible selectable spans over a replayed frame, so text on a
/// screen from three weeks ago can be selected and copied like a normal web page.
pub(super) fn ocr_rgba(img: &RgbaImage) -> anyhow::Result<OcrOutput> {
    use windows::{
        Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap},
        Media::Ocr::OcrEngine,
        Storage::Streams::DataWriter,
    };

    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Ok(OcrOutput::default());
    }

    // Windows OCR wants BGRA8; `image` gives us RGBA8. Swizzle in place.
    let mut bgra: Vec<u8> = Vec::with_capacity((w as usize) * (h as usize) * 4);
    for px in img.pixels() {
        let [r, g, b, a] = px.0;
        bgra.push(b);
        bgra.push(g);
        bgra.push(r);
        bgra.push(a);
    }

    let writer = DataWriter::new()?;
    writer.WriteBytes(&bgra)?;
    let buffer = writer.DetachBuffer()?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        w as i32,
        h as i32,
    )?;

    let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
    let op = engine.RecognizeAsync(&bitmap)?;
    // Block on the WinRT async op via status polling. OCR completes off a thread
    // pool in tens of ms, so a short poll loop avoids depending on the async
    // `.get()` helper (which `windows` 0.62 keeps in the separate `windows-future`
    // crate, not re-exported here) and needs no message pump on this thread.
    // `AsyncStatus` is a stable WinRT ABI enum: Started=0, Completed=1,
    // Canceled=2, Error=3 — read as raw i32 so we don't have to name the type.
    loop {
        let status = op.Status()?.0;
        if status == 1 {
            break; // Completed
        }
        if status != 0 {
            return Err(anyhow::anyhow!(
                "OCR async operation did not complete (status {status})"
            ));
        }
        std::thread::sleep(Duration::from_millis(2)); // Started — keep waiting
    }
    let result = op.GetResults()?;

    // Walk lines → words to keep each word's bounding box. `OcrResult::Text()` gives
    // only the flattened string, which is enough to search but not to point at.
    let (fw, fh) = (w as f32, h as f32);
    let mut words: Vec<OcrWord> = Vec::new();
    'outer: for line in result.Lines()? {
        for word in line.Words()? {
            if words.len() >= MAX_OCR_WORDS {
                break 'outer;
            }
            let text = word.Text()?.to_string();
            if text.trim().is_empty() {
                continue;
            }
            let r = word.BoundingRect()?;
            words.push(OcrWord {
                t: text,
                x: r.X / fw,
                y: r.Y / fh,
                w: r.Width / fw,
                h: r.Height / fh,
            });
        }
    }

    Ok(OcrOutput {
        text: result.Text()?.to_string(),
        words,
    })
}
