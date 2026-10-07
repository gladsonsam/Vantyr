//! Magic prefixes of the binary WebSocket frames an agent sends.
//!
//! A frame without a known prefix is a bare JPEG (live screen).

/// Recall keyframe: `HST\0` + u32 LE header length + header JSON + raw JPEG.
pub const HISTORY_FRAME_MAGIC: &[u8; 4] = b"HST\0";

/// Live audio chunk: `AUD\0` + header + PCM payload.
pub const AUDIO_FRAME_MAGIC: &[u8; 4] = b"AUD\0";
