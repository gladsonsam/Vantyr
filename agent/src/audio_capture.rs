//! Windows WASAPI loopback audio capture (desktop audio → float PCM frames).
//!
//! Captures whatever the system is playing (speakers / headphones output) via the
//! WASAPI shared-mode loopback path and sends raw Float32LE PCM binary frames over
//! the agent WebSocket connection so the server can relay them to live viewers.
//!
//! Frame layout (binary WebSocket message):
//!   [0..4]  b"AUD\0"  — magic discriminator (4 bytes)
//!   [4..8]  sample_rate  u32 LE
//!   [8..10] channels     u16 LE
//!   [10..]  Float32LE interleaved PCM samples

#![cfg(target_os = "windows")]

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use tokio::sync::mpsc;
use tracing::warn;
use windows::{
    Win32::{
        Media::Audio::{
            eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator,
            MMDeviceEnumerator, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
        },
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
            COINIT_APARTMENTTHREADED,
        },
    },
};

/// 4-byte magic identifying a binary audio frame from the agent.
pub const AUDIO_MAGIC: &[u8; 4] = b"AUD\0";

/// WAVEFORMATEX.wFormatTag value for IEEE float samples.
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
/// WAVEFORMATEX.wFormatTag value indicating a WAVEFORMATEXTENSIBLE follows.
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

/// SubFormat GUID for IEEE float: {00000003-0000-0010-8000-00aa00389b71}
const SUBTYPE_FLOAT_BYTES: [u8; 16] = [
    0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
    0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

/// Spawn a background thread that captures WASAPI loopback audio and sends
/// frames to `frame_tx` until `stop` is set.
pub fn start_audio_capture(frame_tx: mpsc::Sender<Vec<u8>>, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            if let Err(e) = capture_loop(&frame_tx, &stop) {
                warn!("Audio capture stopped: {e:#}");
            }
            CoUninitialize();
        }
    });
}

unsafe fn capture_loop(
    frame_tx: &mpsc::Sender<Vec<u8>>,
    stop: &AtomicBool,
) -> anyhow::Result<()> {
    use anyhow::Context;
    use windows::Win32::Media::Audio::WAVEFORMATEX;

    let enumerator: IMMDeviceEnumerator =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .context("CoCreateInstance IMMDeviceEnumerator")?;
    let device = enumerator
        .GetDefaultAudioEndpoint(eRender, eConsole)
        .context("GetDefaultAudioEndpoint")?;
    let client: IAudioClient = device
        .Activate(CLSCTX_ALL, None)
        .context("IMMDevice::Activate IAudioClient")?;

    let fmt_ptr: *mut WAVEFORMATEX = client.GetMixFormat().context("GetMixFormat")?;
    let fmt = &*fmt_ptr;

    let sample_rate = fmt.nSamplesPerSec;
    let channels = fmt.nChannels;
    let bits = fmt.wBitsPerSample;
    let block_align = fmt.nBlockAlign as usize;

    let tag = fmt.wFormatTag;
    let is_float = tag == WAVE_FORMAT_IEEE_FLOAT
        || (tag == WAVE_FORMAT_EXTENSIBLE && {
            // WAVEFORMATEXTENSIBLE layout (byte offsets from the WAVEFORMATEX base pointer):
            // [0..18]  WAVEFORMATEX
            // [18..20] Samples union (wValidBitsPerSample)
            // [20..24] dwChannelMask
            // [24..40] SubFormat GUID (16 bytes)
            let base = fmt_ptr as *const u8;
            let sf: &[u8; 16] = &*(base.add(24) as *const [u8; 16]);
            *sf == SUBTYPE_FLOAT_BYTES
        });

    // 100 ms buffer (in 100-nanosecond units).
    let buffer_duration: i64 = 10_000_000 / 10;

    client
        .Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            buffer_duration,
            0,
            fmt_ptr,
            None,
        )
        .context("IAudioClient::Initialize")?;

    let capture: IAudioCaptureClient = client.GetService().context("GetService")?;
    client.Start().context("IAudioClient::Start")?;

    while !stop.load(Ordering::Relaxed) {
        let packet_frames = capture.GetNextPacketSize().unwrap_or(0);
        if packet_frames == 0 {
            std::thread::sleep(std::time::Duration::from_millis(10));
            continue;
        }

        let mut buf_ptr: *mut u8 = std::ptr::null_mut();
        let mut frames: u32 = 0;
        let mut raw_flags: u32 = 0;

        if capture
            .GetBuffer(&mut buf_ptr, &mut frames, &mut raw_flags, None, None)
            .is_err()
        {
            break;
        }

        if frames > 0 {
            let byte_count = frames as usize * block_align;
            let raw = std::slice::from_raw_parts(buf_ptr, byte_count);

            const SILENT_FLAG: u32 = 0x2; // AUDCLNT_BUFFERFLAGS_SILENT
            let pcm_floats: Vec<f32> = if (raw_flags & SILENT_FLAG) != 0 {
                vec![0.0f32; frames as usize * channels as usize]
            } else if is_float && bits == 32 {
                raw.chunks_exact(4)
                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                    .collect()
            } else if bits == 16 {
                raw.chunks_exact(2)
                    .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
                    .collect()
            } else {
                let _ = capture.ReleaseBuffer(frames);
                continue;
            };

            // Build frame: magic (4) + sample_rate (4 LE) + channels (2 LE) + Float32LE PCM.
            let mut frame: Vec<u8> = Vec::with_capacity(10 + pcm_floats.len() * 4);
            frame.extend_from_slice(AUDIO_MAGIC);
            frame.extend_from_slice(&sample_rate.to_le_bytes());
            frame.extend_from_slice(&channels.to_le_bytes());
            for s in &pcm_floats {
                frame.extend_from_slice(&s.to_le_bytes());
            }
            let _ = frame_tx.blocking_send(frame);
        }

        let _ = capture.ReleaseBuffer(frames);
    }

    let _ = client.Stop();
    CoTaskMemFree(Some(fmt_ptr as *mut _));
    Ok(())
}
