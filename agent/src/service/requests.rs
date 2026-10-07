//! Handling one request on the privileged service pipe
//! ([`crate::ipc::SERVICE_PIPE_NAME`]): read a [`ServiceRequest`] line, run it,
//! reply with one `{"ok": …}` line.

use std::path::PathBuf;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::NamedPipeServer;
use tracing::warn;

use super::msi_install::{install_msi_and_exit, trusted_staged_msi_path};
use super::pipe_server::{service_job_mutex, service_pipe_reply};
use crate::ipc::{ServiceRequest, MAX_SERVICE_PIPE_LINE};

/// Serve one connected client: `caller_trusted` must be decided while the pipe
/// is connected (see [`super::pipe_server::pipe_caller_is_trusted_agent`]);
/// privileged actions are refused unless it is set.
pub(super) async fn handle_service_request(pipe: NamedPipeServer, caller_trusted: bool) {
    let mut reader = BufReader::new(pipe);
    let mut buf = Vec::new();
    match reader.read_until(b'\n', &mut buf).await {
        Ok(0) => {
            warn!("Service pipe: EOF before request line");
            let resp = service_pipe_reply(serde_json::json!({
                "ok": false,
                "error": "empty service pipe request",
            }));
            write_reply(&mut reader.into_inner(), &resp).await;
            return;
        }
        Ok(_) => {}
        Err(e) => {
            warn!("Service pipe: read failed: {e:#}");
            let resp = service_pipe_reply(serde_json::json!({
                "ok": false,
                "error": format!("pipe read: {e:#}"),
            }));
            write_reply(&mut reader.into_inner(), &resp).await;
            return;
        }
    }
    while matches!(buf.last().copied(), Some(b'\n' | b'\r')) {
        buf.pop();
    }
    if buf.is_empty() {
        warn!("Service pipe: empty request line");
        let resp = service_pipe_reply(serde_json::json!({
            "ok": false,
            "error": "empty service pipe request",
        }));
        write_reply(&mut reader.into_inner(), &resp).await;
        return;
    }
    if buf.len() > MAX_SERVICE_PIPE_LINE {
        warn!("Service pipe: request line too large ({})", buf.len());
        let resp = service_pipe_reply(serde_json::json!({
            "ok": false,
            "error": "service pipe request too large",
        }));
        write_reply(&mut reader.into_inner(), &resp).await;
        return;
    }

    let v: serde_json::Value = match serde_json::from_slice(&buf) {
        Ok(v) => v,
        Err(e) => {
            let resp = service_pipe_reply(serde_json::json!({
                "ok": false,
                "error": format!("invalid JSON on service pipe: {e}"),
            }));
            write_reply(&mut reader.into_inner(), &resp).await;
            return;
        }
    };
    let mut pipe = reader.into_inner();
    let action = v
        .get("action")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let request = serde_json::from_value::<ServiceRequest>(v);

    let _job = service_job_mutex().lock().await;

    // Reply on the pipe before starting msiexec so StopServices cannot tear
    // down the runtime before the client reads the line.
    let (resp, msi_to_run_after_reply) = run_request(request, &action, caller_trusted).await;

    write_reply(&mut pipe, &service_pipe_reply(resp)).await;

    if let Some(msi_path) = msi_to_run_after_reply {
        install_msi_and_exit(&msi_path);
    }
}

async fn write_reply(pipe: &mut NamedPipeServer, resp: &str) {
    let _ = pipe.write_all(resp.as_bytes()).await;
    let _ = pipe.flush().await;
}

/// Run one parsed request; returns the reply and, for an accepted
/// `install_msi`, the MSI to launch once the reply is flushed.
async fn run_request(
    request: Result<ServiceRequest, serde_json::Error>,
    action: &str,
    caller_trusted: bool,
) -> (serde_json::Value, Option<PathBuf>) {
    match request {
        Ok(ServiceRequest::InstallMsi { msi_path }) => install_msi(&msi_path),
        Ok(ServiceRequest::SetNetworkPolicy { .. } | ServiceRequest::ClearLogFile { .. })
            if !caller_trusted =>
        {
            (
                serde_json::json!({"ok": false, "error": "unauthorized caller"}),
                None,
            )
        }
        Ok(ServiceRequest::SetNetworkPolicy {
            generation,
            blocked,
            server_hostname,
            server_port,
        }) => (
            set_network_policy(generation, blocked, server_hostname, server_port).await,
            None,
        ),
        Ok(ServiceRequest::ClearLogFile { kind }) => (clear_log_file(kind.trim()), None),
        Err(_) if !ServiceRequest::ACTIONS.contains(&action) => (
            serde_json::json!({
                "ok": false,
                "error": format!("unknown pipe action: {action:?}"),
            }),
            None,
        ),
        Err(e) => (
            serde_json::json!({
                "ok": false,
                "error": format!("invalid {action} request: {e}"),
            }),
            None,
        ),
    }
}

fn install_msi(msi_path: &str) -> (serde_json::Value, Option<PathBuf>) {
    if msi_path.is_empty() {
        return (
            serde_json::json!({
                "ok": false,
                "error": "install_msi requires msi_path",
            }),
            None,
        );
    }
    match trusted_staged_msi_path(&PathBuf::from(msi_path)) {
        Ok(canon) => (
            serde_json::json!({
                "ok": true,
                "status": "install_started",
            }),
            Some(canon),
        ),
        Err(e) => (
            serde_json::json!({"ok": false, "error": format!("{e:#}")}),
            None,
        ),
    }
}

/// Run netsh from the SYSTEM service so no elevation prompt is needed.
async fn set_network_policy(
    generation: Option<crate::permissions::Generation>,
    blocked: bool,
    hostname: String,
    port: u16,
) -> serde_json::Value {
    let lease = generation.map(crate::permissions::WorkerLease::new);
    let result = tokio::task::spawn_blocking(move || {
        let _lease = lease;
        if blocked
            && !generation.is_some_and(|g| {
                g.module == crate::permissions::Module::NetworkPolicy && g.valid_fresh()
            })
        {
            Err(anyhow::anyhow!("network policy not locally authorized"))
        } else if blocked {
            crate::network_policy::apply_block(&hostname, port)
        } else {
            crate::network_policy::remove_block()
        }
    })
    .await;
    match result {
        Ok(Ok(())) => serde_json::json!({"ok": true}),
        Ok(Err(e)) => serde_json::json!({"ok": false, "error": format!("{e:#}")}),
        Err(e) => serde_json::json!({"ok": false, "error": format!("spawn_blocking: {e}")}),
    }
}

fn clear_log_file(kind: &str) -> serde_json::Value {
    if kind.is_empty() {
        return serde_json::json!({"ok": false, "error": "clear_log_file requires kind"});
    }
    // Allowlisted kinds only; never an arbitrary path.
    match crate::log_sources::resolve_fixed_log_kind(kind) {
        Err(e) => serde_json::json!({"ok": false, "error": e}),
        Ok(path) => {
            // Truncate from the SYSTEM service so ownership/ACL doesn't block the user UI.
            match std::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&path)
            {
                Ok(_) => serde_json::json!({"ok": true}),
                Err(e) => {
                    serde_json::json!({"ok": false, "error": format!("Could not clear log: {e}")})
                }
            }
        }
    }
}
