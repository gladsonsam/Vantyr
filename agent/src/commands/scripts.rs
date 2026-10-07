//! Remote script execution (`RunScript`).

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::warn;

use crate::permissions::Generation;

pub(super) fn run_script(
    val: &serde_json::Value,
    generation: Option<Generation>,
    out_tx: mpsc::Sender<Message>,
) {
    let request_id = val["request_id"].as_str().unwrap_or("").to_string();
    if request_id.is_empty() {
        warn!("RunScript missing request_id");
        return;
    }
    let shell = val["shell"].as_str().unwrap_or("powershell").to_lowercase();
    let script = val["script"].as_str().unwrap_or("").to_string();
    if script.len() > 256 * 1024 {
        warn!("RunScript rejected: script too large");
        return;
    }
    let timeout_secs = val["timeout_secs"].as_u64().unwrap_or(120).clamp(5, 300);
    let out = out_tx;
    crate::permissions::spawn_for_command(generation, async move {
        let r = crate::platform::script_execution::run(&shell, &script, timeout_secs).await;
        let payload = serde_json::json!({
            "type": "script_result",
            "request_id": request_id,
            "ok": r.ok,
            "exit_code": r.exit_code,
            "stdout": r.stdout,
            "stderr": r.stderr,
            "error": r.error,
        })
        .to_string();
        let _ = out
            .send(crate::permissions::tag_message(
                Message::Text(payload),
                generation,
            ))
            .await;
    });
}
