//! Vantyr's maintained subset of Tembo voxl: desktop H.264 encoding only.
//! No listeners, authentication, file access or input injection run in this crate.
mod convert;
mod encoder;
use encoder::{Encoder, EncoderConfig, Planes};

pub struct DesktopEncoder {
    encoder: Encoder,
    planes: convert::I420,
    bgrx: Vec<u8>,
    width: u32,
    height: u32,
    quality: u8,
}
impl DesktopEncoder {
    pub fn new(width: u32, height: u32, fps: u32, quality: u8) -> Result<Self, String> {
        if width == 0 || height == 0 || width > 16384 || height > 16384 {
            return Err("unsupported capture dimensions".into());
        }
        // I420 requires even dimensions. Pad the right/bottom edge without changing
        // capture geometry; the browser clips the padded video to the source size.
        let (w, h) = ((width + 1) & !1, (height + 1) & !1);
        let encoder = Encoder::new(&EncoderConfig {
            width: w,
            height: h,
            fps: fps.clamp(1, 60),
            preset: "ultrafast".into(),
            threads: 2,
            crf: 38.0 - quality.clamp(1, 100) as f32 * 0.24,
            max_kbps: 12000,
        })?;
        Ok(Self {
            encoder,
            planes: convert::I420::new(w as usize, h as usize),
            bgrx: vec![0; w as usize * h as usize * 4],
            width,
            height,
            quality,
        })
    }
    /// Rate-control reconfiguration keeps the encoder and SPS geometry intact.
    /// Packets already repeat SPS/PPS and force IDR for latest-frame delivery.
    pub fn set_quality(&mut self, quality: u8) {
        if self.quality == quality {
            return;
        }
        self.quality = quality;
        self.encoder
            .set_rate(38.0 - quality.clamp(1, 100) as f32 * 0.24, 12000);
    }
    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }
    pub fn encode_rgba(&mut self, rgba: &[u8], timestamp_ms: i64) -> Result<Vec<u8>, String> {
        if rgba.len() != self.width as usize * self.height as usize * 4 {
            return Err("invalid RGBA capture length".into());
        }
        let w = self.encoder.width as usize;
        let h = self.encoder.height as usize;
        for y in 0..h {
            for x in 0..w {
                let source = (y.min(self.height as usize - 1) * self.width as usize
                    + x.min(self.width as usize - 1))
                    * 4;
                let dest = (y * w + x) * 4;
                self.bgrx[dest..dest + 4].copy_from_slice(&[
                    rgba[source + 2],
                    rgba[source + 1],
                    rgba[source],
                    255,
                ]);
            }
        }
        convert::convert_band(&self.bgrx, w * 4, &mut self.planes, 0, h, 2);
        let planes = Planes {
            y: &self.planes.y,
            u: &self.planes.u,
            v: &self.planes.v,
            stride_y: w,
            stride_uv: self.planes.stride_uv(),
        };
        let mut out = Vec::new();
        // Each packet is independently decodable: existing latest-frame broadcast
        // may drop packets under backpressure or admit a new viewer at any point.
        self.encoder
            .encode(&planes, timestamp_ms, true, None, None, &mut out)?;
        Ok(out)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn produces_independent_annex_b_frames_and_rejects_bad_buffers() {
        let mut encoder = DesktopEncoder::new(65, 33, 30, 70).unwrap();
        assert!(encoder.encode_rgba(&[0; 4], 0).is_err());
        for n in 0..3 {
            let data = encoder
                .encode_rgba(&vec![160; 65 * 33 * 4], n * 33)
                .unwrap();
            // Every packet includes SPS, PPS and IDR (NAL types 7, 8, 5).
            let types: Vec<_> = data
                .windows(5)
                .filter(|b| b[..4] == [0, 0, 0, 1])
                .map(|b| b[4] & 31)
                .collect();
            assert!(types.contains(&7) && types.contains(&8));
            assert!(data
                .windows(4)
                .any(|b| b[..3] == [0, 0, 1] && b[3] & 31 == 5));
        }
    }
}
