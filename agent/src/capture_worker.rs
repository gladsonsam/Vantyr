//! SYSTEM capture worker (Windows).
//!
//! Launched by the Session 0 service as **LocalSystem** into the active console
//! session (`--capture-worker`). It exists precisely to solve the lock-screen
//! gap: the ordinary user-session companion is pinned to the `Default` desktop
//! with the user's token and can neither see nor drive the secure `Winlogon`
//! desktop, and before anyone signs in there is no user token at all — so the
//! companion isn't even running yet. This worker, being SYSTEM in the console
//! session, is present from the sign-in screen onward and re-attaches its
//! capture and input threads to whichever desktop currently owns input.
//!
//! Wiring: it is just another client of the service's `AGENT_IPC` pipe. It
//! receives the same server-command broadcast as the companion, but acts only on
//! `start_capture` / `stop_capture` and remote-input commands; screen frames go
//! back to the service (and on to the dashboard) as `WsBinaryB64` IPC lines. The
//! companion suppresses those same commands (see [`crate::role`]) so exactly one
//! process captures each monitor.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ClientOptions;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::capture::CaptureSettings;
use crate::input::InputController;

/// Frame queue between the capture thread and the pipe writer. Small on purpose:
/// capture drops stale frames when full, keeping the live view low-latency.
const FRAME_QUEUE: usize = 2;

/// Entry point for `--capture-worker`. Never returns under normal operation; it
/// reconnects to the service pipe forever (the service kills this process by
/// image name on stop / update).
pub fn run() {
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            warn!("Capture worker: failed to build runtime: {e}");
            return;
        }
    };

    rt.block_on(async {
        // Dedicated OS thread for input injection: SendInput targets the desktop
        // its calling thread is attached to, so injection must run on a thread
        // that follows the input desktop — not a shared async worker.
        let (input_tx, input_rx) = std::sync::mpsc::channel::<String>();
        std::thread::Builder::new()
            .name("worker-input".into())
            .spawn(move || input_thread(input_rx))
            .ok();

        loop {
            if let Err(e) = run_session(&input_tx).await {
                warn!("Capture worker session ended: {e:#}");
            }
            // Service may be restarting or the pipe briefly unavailable; retry.
            tokio::time::sleep(Duration::from_millis(750)).await;
        }
    });
}

/// One connection to the service IPC pipe: read commands, stream frames back.
async fn run_session(input_tx: &std::sync::mpsc::Sender<String>) -> anyhow::Result<()> {
    let pipe = ClientOptions::new()
        .open(crate::ipc::AGENT_IPC_PIPE_NAME)
        .map_err(|e| anyhow::anyhow!("open agent IPC pipe: {e}"))?;
    info!("Capture worker connected to service IPC.");

    let (pipe_r, mut pipe_w) = tokio::io::split(pipe);
    let mut reader = BufReader::new(pipe_r);

    // Frames from the capture thread → base64 IPC lines on the pipe.
    let (frame_tx, mut frame_rx) = mpsc::channel::<Vec<u8>>(FRAME_QUEUE);
    let writer = tokio::spawn(async move {
        while let Some(frame) = frame_rx.recv().await {
            let line = crate::ipc::outbound_binary_line(&frame);
            if pipe_w.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if pipe_w.flush().await.is_err() {
                break;
            }
        }
    });

    // Current capture generation's stop flag (replaced on each start_capture).
    let mut capture_stop: Option<Arc<AtomicBool>> = None;

    let mut buf = Vec::new();
    let result = loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break Ok(()), // pipe closed
            Ok(_) => {}
            Err(e) => break Err(anyhow::anyhow!("pipe read: {e}")),
        }
        while matches!(buf.last().copied(), Some(b'\n' | b'\r')) {
            buf.pop();
        }
        if buf.is_empty() {
            continue;
        }

        // Service-originated IPC frames (status/config) parse as `IpcLine`; ignore
        // them. Anything else is a server command as raw JSON text.
        if crate::ipc::IpcLine::from_slice(&buf).is_some() {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&buf) else {
            continue;
        };
        let Ok(val) = serde_json::from_str::<serde_json::Value>(text) else {
            continue;
        };
        let command = val.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match command {
            "start_capture" => {
                let mut settings = CaptureSettings::from_server_command(&val);
                // The whole point of this process: follow the input desktop.
                settings.follow_input_desktop = true;

                if let Some(stop) = capture_stop.take() {
                    stop.store(true, Ordering::Relaxed);
                }
                let stop = Arc::new(AtomicBool::new(false));
                match crate::capture::start_capture(frame_tx.clone(), stop.clone(), settings) {
                    Ok(()) => {
                        capture_stop = Some(stop);
                        info!(
                            "Capture worker: streaming (jpeg_q={}, interval_ms={}).",
                            settings.jpeg_quality, settings.interval_ms
                        );
                    }
                    Err(e) => warn!("Capture worker: failed to start capture: {e:#}"),
                }
            }
            "stop_capture" => {
                if let Some(stop) = capture_stop.take() {
                    stop.store(true, Ordering::Relaxed);
                    info!("Capture worker: capture stopped (no viewers).");
                }
            }
            // Everything else the worker cares about is remote input; hand the raw
            // JSON to the desktop-following input thread. Non-input commands simply
            // fail to deserialize there and are ignored.
            _ => {
                let _ = input_tx.send(text.to_string());
            }
        }
    };

    // Tear down this generation's capture before reconnecting.
    if let Some(stop) = capture_stop.take() {
        stop.store(true, Ordering::Relaxed);
    }
    drop(frame_tx);
    let _ = writer.await;
    result
}

/// Owns the `InputController`, re-attaching to the input desktop as it changes.
///
/// `SetThreadDesktop` is rejected once a thread owns windows, and `Enigo` may
/// create a message window bound to its desktop — so on every desktop switch we
/// drop the controller *before* re-attaching, then build a fresh one on the new
/// desktop.
fn input_thread(rx: std::sync::mpsc::Receiver<String>) {
    let mut attachment: Option<crate::secure_desktop::DesktopAttachment> = None;
    let mut controller: Option<InputController> = None;

    while let Ok(json) = rx.recv() {
        let current = crate::secure_desktop::input_desktop_name();
        let need_reattach = match (attachment.as_ref(), current.as_ref()) {
            (Some(a), Some(cur)) => a.name() != cur.as_str(),
            _ => true,
        };

        if need_reattach {
            // Drop controller first so no window keeps us bound to the old desktop.
            controller = None;
            attachment = None;
            match crate::secure_desktop::attach_current_thread_to_input_desktop() {
                Ok(a) => {
                    info!("Capture worker: input attached to desktop '{}'.", a.name());
                    attachment = Some(a);
                    match InputController::new() {
                        Ok(c) => controller = Some(c),
                        Err(e) => {
                            warn!("Capture worker: input controller init failed: {e:#}");
                            continue;
                        }
                    }
                }
                Err(e) => {
                    // No reachable input desktop this instant; drop the command.
                    warn!("Capture worker: cannot attach input desktop: {e:#}");
                    continue;
                }
            }
        }

        if let Some(ctrl) = controller.as_mut() {
            if let Err(e) = ctrl.handle_command(&json) {
                warn!("Capture worker: control command error: {e:#}");
            }
        }
    }
}
