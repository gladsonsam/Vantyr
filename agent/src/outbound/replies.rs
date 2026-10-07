//! One-shot replies to server commands: file browser, logs, scripts, clipboard,
//! update notices and the module-disable acknowledgement.

use serde::Serialize;
use vantyr_protocol::Module;

/// `fs_op_result`: the outcome of `Mkdir` / `RenamePath` / `CopyPath` / `DeletePath`.
///
/// Which of `path` / `src` / `dst` / `recursive` are present depends on the operation,
/// so use the constructor for it. `error` is `null` on success.
#[derive(Serialize)]
#[serde(tag = "type", rename = "fs_op_result")]
pub struct FsOpResult<'a> {
    pub request_id: &'a str,
    pub op: &'static str,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dst: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recursive: Option<bool>,
    pub error: Option<&'a str>,
}

impl<'a> FsOpResult<'a> {
    fn base(request_id: &'a str, op: &'static str, error: Option<&'a str>) -> Self {
        Self {
            request_id,
            op,
            ok: error.is_none(),
            path: None,
            src: None,
            dst: None,
            recursive: None,
            error,
        }
    }

    pub fn mkdir(request_id: &'a str, path: &'a str, error: Option<&'a str>) -> Self {
        Self {
            path: Some(path),
            ..Self::base(request_id, "mkdir", error)
        }
    }

    pub fn rename(request_id: &'a str, src: &'a str, dst: &'a str, error: Option<&'a str>) -> Self {
        Self {
            src: Some(src),
            dst: Some(dst),
            ..Self::base(request_id, "rename", error)
        }
    }

    pub fn copy(request_id: &'a str, src: &'a str, dst: &'a str, error: Option<&'a str>) -> Self {
        Self {
            src: Some(src),
            dst: Some(dst),
            ..Self::base(request_id, "copy", error)
        }
    }

    pub fn delete(
        request_id: &'a str,
        path: &'a str,
        recursive: bool,
        error: Option<&'a str>,
    ) -> Self {
        Self {
            path: Some(path),
            recursive: Some(recursive),
            ..Self::base(request_id, "delete", error)
        }
    }
}

/// One row of a `dir_list`.
#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

impl DirEntry {
    /// A drive root or mount point in the "This PC" listing.
    pub fn drive(name: String) -> Self {
        Self {
            name,
            is_dir: true,
            size: 0,
        }
    }
}

/// `dir_list`: the entries of a directory (or the drives, for the "This PC" path).
#[derive(Serialize)]
#[serde(tag = "type", rename = "dir_list")]
pub struct DirList<'a> {
    pub path: &'a str,
    pub items: &'a [DirEntry],
}

/// `file_chunk`: one base64 slice of a downloaded file, or the error that ended it
/// (`is_error`, with the message in `data`).
#[derive(Serialize)]
#[serde(tag = "type", rename = "file_chunk")]
pub struct FileChunk<'a> {
    pub path: &'a str,
    pub data: &'a str,
    pub chunk_index: usize,
    pub total_chunks: usize,
    pub is_error: bool,
}

/// `file_upload_result`: an upload failed, or its last chunk landed (`error` is empty).
#[derive(Serialize)]
#[serde(tag = "type", rename = "file_upload_result")]
pub struct FileUploadResult<'a> {
    pub path: &'a str,
    pub ok: bool,
    pub error: &'a str,
}

/// `log_sources`: the readable log sources, as the host serializes them.
#[derive(Serialize)]
#[serde(tag = "type", rename = "log_sources")]
pub struct LogSources<'a> {
    pub request_id: &'a str,
    pub sources: &'a [serde_json::Value],
}

/// `log_tail`: the end of one log (or a parenthesised reason it could not be read).
#[derive(Serialize)]
#[serde(tag = "type", rename = "log_tail")]
pub struct LogTail<'a> {
    pub request_id: &'a str,
    pub kind: &'a str,
    pub text: &'a str,
}

/// `script_result`: how a `RunScript` ended.
#[derive(Serialize)]
#[serde(tag = "type", rename = "script_result")]
pub struct ScriptResult<'a> {
    pub request_id: &'a str,
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub stdout: &'a str,
    pub stderr: &'a str,
    pub error: Option<&'a str>,
}

/// `notify`: a short notice for the dashboard.
#[derive(Serialize)]
#[serde(tag = "type", rename = "notify")]
pub struct Notify {
    pub level: &'static str,
    pub message: &'static str,
}

/// `clipboard_result`: the outcome of a `ClipboardRead` / `ClipboardWrite`. `text` is
/// only present for a read that produced text. `request_id` is echoed exactly as the
/// request carried it.
#[derive(Serialize)]
#[serde(tag = "type", rename = "clipboard_result")]
pub struct ClipboardResult<'a> {
    pub request_id: &'a serde_json::Value,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<&'a str>,
}

/// `module_disable_ack` for a disable that was processed (applied, replayed or stale).
/// `command_id` / `module` echo the request.
#[derive(Serialize)]
#[serde(tag = "type", rename = "module_disable_ack")]
pub struct ModuleDisableAck<'a> {
    pub command_id: &'a serde_json::Value,
    pub module: &'a serde_json::Value,
    pub ok: bool,
    pub status: String,
    pub persisted: bool,
    pub stopped: bool,
    pub stop_status: &'static str,
    pub state: serde_json::Value,
}

/// `module_disable_ack` for a disable that could not be processed.
#[derive(Serialize)]
#[serde(tag = "type", rename = "module_disable_ack")]
pub struct ModuleDisableFailed<'a> {
    pub command_id: &'a serde_json::Value,
    pub module: &'a serde_json::Value,
    pub ok: bool,
    pub status: &'static str,
    pub error: String,
}

/// `module_states`: the device's local module grants.
#[derive(Serialize)]
#[serde(tag = "type", rename = "module_states")]
pub struct ModuleStates {
    pub schema_version: u32,
    pub revision: u64,
    pub modules: Vec<ModuleState>,
}

/// One module's grant inside [`ModuleStates`].
#[derive(Serialize)]
pub struct ModuleState {
    pub module: Module,
    pub available: bool,
    pub enabled: bool,
    pub revision: u64,
    pub authorization_required: bool,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::outbound::to_value;

    /// The typed message and the `json!` literal it replaced must serialize identically.
    fn same(typed: serde_json::Value, literal: serde_json::Value) {
        assert_eq!(typed.to_string(), literal.to_string());
    }

    #[test]
    fn fs_op_results_match_the_json_shape() {
        same(
            to_value(&FsOpResult::mkdir("r1", "/tmp/a", None)),
            json!({"type": "fs_op_result", "request_id": "r1", "op": "mkdir", "ok": true, "path": "/tmp/a", "error": null}),
        );
        same(
            to_value(&FsOpResult::rename("r2", "/a", "/b", Some("denied"))),
            json!({"type": "fs_op_result", "request_id": "r2", "op": "rename", "ok": false, "src": "/a", "dst": "/b", "error": "denied"}),
        );
        same(
            to_value(&FsOpResult::copy("r3", "/a", "/b", None)),
            json!({"type": "fs_op_result", "request_id": "r3", "op": "copy", "ok": true, "src": "/a", "dst": "/b", "error": null}),
        );
        same(
            to_value(&FsOpResult::delete("r4", "/a", true, None)),
            json!({"type": "fs_op_result", "request_id": "r4", "op": "delete", "ok": true, "path": "/a", "recursive": true, "error": null}),
        );
    }

    #[test]
    fn dir_list_matches_the_json_shape() {
        let items = [
            DirEntry::drive("C:\\".into()),
            DirEntry {
                name: "notes.txt".into(),
                is_dir: false,
                size: 12,
            },
        ];
        same(
            to_value(&DirList {
                path: "__this_pc__",
                items: &items,
            }),
            json!({
                "type": "dir_list",
                "path": "__this_pc__",
                "items": [
                    {"name": "C:\\", "is_dir": true, "size": 0},
                    {"name": "notes.txt", "is_dir": false, "size": 12},
                ],
            }),
        );
    }

    #[test]
    fn file_transfer_replies_match_the_json_shape() {
        same(
            to_value(&FileChunk {
                path: "/a",
                data: "QUJD",
                chunk_index: 2,
                total_chunks: 5,
                is_error: false,
            }),
            json!({"type": "file_chunk", "path": "/a", "data": "QUJD", "chunk_index": 2, "total_chunks": 5, "is_error": false}),
        );
        same(
            to_value(&FileUploadResult {
                path: "/a",
                ok: false,
                error: "invalid upload parameters",
            }),
            json!({"type": "file_upload_result", "path": "/a", "ok": false, "error": "invalid upload parameters"}),
        );
    }

    #[test]
    fn log_and_script_replies_match_the_json_shape() {
        let sources = [json!({"kind": "local_agent"})];
        same(
            to_value(&LogSources {
                request_id: "r",
                sources: &sources,
            }),
            json!({"type": "log_sources", "request_id": "r", "sources": [{"kind": "local_agent"}]}),
        );
        same(
            to_value(&LogTail {
                request_id: "r",
                kind: "local_agent",
                text: "line",
            }),
            json!({"type": "log_tail", "request_id": "r", "kind": "local_agent", "text": "line"}),
        );
        same(
            to_value(&ScriptResult {
                request_id: "r",
                ok: false,
                exit_code: Some(3),
                stdout: "o",
                stderr: "e",
                error: None,
            }),
            json!({"type": "script_result", "request_id": "r", "ok": false, "exit_code": 3, "stdout": "o", "stderr": "e", "error": null}),
        );
    }

    #[test]
    fn notify_and_clipboard_replies_match_the_json_shape() {
        same(
            to_value(&Notify {
                level: "info",
                message: "Update downloaded; installing...",
            }),
            json!({"type": "notify", "level": "info", "message": "Update downloaded; installing..."}),
        );
        let id = json!("0a0b");
        same(
            to_value(&ClipboardResult {
                request_id: &id,
                ok: true,
                text: Some("hi"),
            }),
            json!({"type": "clipboard_result", "request_id": "0a0b", "ok": true, "text": "hi"}),
        );
        same(
            to_value(&ClipboardResult {
                request_id: &id,
                ok: false,
                text: None,
            }),
            json!({"type": "clipboard_result", "request_id": "0a0b", "ok": false}),
        );
        // A missing request id stays `null`, as it did when read off the request by index.
        let missing = json!(null);
        same(
            to_value(&ClipboardResult {
                request_id: &missing,
                ok: false,
                text: None,
            }),
            json!({"type": "clipboard_result", "request_id": null, "ok": false}),
        );
    }

    #[test]
    fn module_replies_match_the_json_shape() {
        let (command_id, module) = (json!("c1"), json!("clipboard"));
        let state = json!({"type": "module_states"});
        same(
            to_value(&ModuleDisableAck {
                command_id: &command_id,
                module: &module,
                ok: true,
                status: "disabled".into(),
                persisted: true,
                stopped: false,
                stop_status: "unconfirmed",
                state: state.clone(),
            }),
            json!({"type": "module_disable_ack", "command_id": "c1", "module": "clipboard", "ok": true, "status": "disabled", "persisted": true, "stopped": false, "stop_status": "unconfirmed", "state": state}),
        );
        same(
            to_value(&ModuleDisableFailed {
                command_id: &command_id,
                module: &module,
                ok: false,
                status: "error",
                error: "boom".into(),
            }),
            json!({"type": "module_disable_ack", "command_id": "c1", "module": "clipboard", "ok": false, "status": "error", "error": "boom"}),
        );
        same(
            to_value(&ModuleStates {
                schema_version: 1,
                revision: 4,
                modules: vec![ModuleState {
                    module: Module::Clipboard,
                    available: true,
                    enabled: false,
                    revision: 2,
                    authorization_required: true,
                }],
            }),
            json!({
                "type": "module_states",
                "schema_version": 1,
                "revision": 4,
                "modules": [{"module": Module::Clipboard, "available": true, "enabled": false, "revision": 2, "authorization_required": true}],
            }),
        );
    }
}
