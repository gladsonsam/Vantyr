//! Live screen and audio streaming, started and stopped as dashboard viewers
//! come and go.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use tokio::sync::mpsc;
use tracing::{info, warn};

use super::protocol::StartCapture;
use crate::permissions::Generation;

pub(super) fn start_capture(
    cmd: StartCapture,
    generation: Option<Generation>,
    frame_tx: &mpsc::Sender<Vec<u8>>,
    capture_stop: &mut Option<Arc<AtomicBool>>,
) {
    let Some(command_generation) = generation else {
        return;
    };
    let settings = crate::capture::screen::CaptureSettings::from_request(&cmd);
    let jpeg_quality = settings.jpeg_quality;
    let interval_ms = settings.interval_ms;

    // Replace any existing capture thread so updated settings apply immediately.
    if let Some(stop) = capture_stop.take() {
        stop.store(true, Ordering::Relaxed);
    }

    let stop = Arc::new(AtomicBool::new(false));
    match crate::capture::screen::start_capture(
        frame_tx.clone(),
        stop.clone(),
        settings,
        command_generation,
    ) {
        Ok(()) => {
            *capture_stop = Some(stop);
            info!(
                "Screen capture started (viewer connected): jpeg_q={}, interval_ms={}",
                jpeg_quality, interval_ms
            );
        }
        Err(e) => warn!("Failed to start capture: {e}"),
    }
}

pub(super) fn stop_capture(capture_stop: &mut Option<Arc<AtomicBool>>) {
    if let Some(stop) = capture_stop.take() {
        stop.store(true, Ordering::Relaxed);
        info!("Screen capture stopped (no viewers remaining).");
    }
}

pub(super) fn start_audio(
    generation: Option<Generation>,
    frame_tx: &mpsc::Sender<Vec<u8>>,
    audio_stop: &mut Option<Arc<AtomicBool>>,
) {
    let Some(command_generation) = generation else {
        return;
    };
    #[cfg(target_os = "windows")]
    {
        // Replace any running audio capture so the viewer refcount stays correct.
        if let Some(stop) = audio_stop.take() {
            stop.store(true, Ordering::Relaxed);
        }
        let stop = Arc::new(AtomicBool::new(false));
        crate::capture::audio::start_audio_capture(
            frame_tx.clone(),
            stop.clone(),
            command_generation,
        );
        *audio_stop = Some(stop);
        info!("Audio capture started.");
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (audio_stop, command_generation, frame_tx);
        warn!("start_audio is only supported on Windows.");
    }
}

pub(super) fn stop_audio(audio_stop: &mut Option<Arc<AtomicBool>>) {
    if let Some(stop) = audio_stop.take() {
        stop.store(true, Ordering::Relaxed);
        info!("Audio capture stopped.");
    }
}
