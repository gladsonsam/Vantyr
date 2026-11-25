//! Emit three independently decodable frames for an external decoder smoke test.
use std::io::Write;
fn main() {
    let path = std::env::args().nth(1).expect("output .h264 path");
    let mut file = std::fs::File::create(path).unwrap();
    let mut encoder = vantyr_voxl_codec::DesktopEncoder::new(65, 33, 30, 80).unwrap();
    for n in 0..3 {
        let rgba = [220, 40 + n * 50, 30, 255].repeat(65 * 33);
        file.write_all(&encoder.encode_rgba(&rgba, n as i64 * 33).unwrap())
            .unwrap();
    }
}
