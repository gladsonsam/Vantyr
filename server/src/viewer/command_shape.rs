//! Shape validation for viewer `control` commands, before they are forwarded to an agent.
//! Pure: no I/O, so every accepted and rejected shape is unit-testable.

use serde_json::Value;

const MAX_TYPE_TEXT_CHARS: usize = 2_000;
const MAX_NOTIFY_TITLE_CHARS: usize = 64;
const MAX_NOTIFY_MESSAGE_CHARS: usize = 256;
const MAX_FS_PATH_CHARS: usize = 2048;
const MAX_FS_NAME_CHARS: usize = 256;

/// Whether `cmd` (the `cmd` object of a viewer `control` message) has a known `cmd_type` and
/// an acceptable shape.
pub(super) fn is_valid(cmd_type: &str, cmd: &Value) -> bool {
    match cmd_type {
        "MouseMove" => {
            let x_ok = cmd["x"].as_i64().is_some_and(|v| i32::try_from(v).is_ok());
            let y_ok = cmd["y"].as_i64().is_some_and(|v| i32::try_from(v).is_ok());
            x_ok && y_ok
        }
        "MouseClick" | "MouseDoubleClick" | "MouseDown" | "MouseUp" => {
            let x_ok = cmd["x"].as_i64().is_some_and(|v| i32::try_from(v).is_ok());
            let y_ok = cmd["y"].as_i64().is_some_and(|v| i32::try_from(v).is_ok());
            let button_ok = cmd["button"]
                .as_str()
                .is_none_or(|b| matches!(b, "left" | "right" | "middle"));
            x_ok && y_ok && button_ok
        }
        "MouseScroll" => {
            let dx_ok = cmd["delta_x"]
                .as_i64()
                .is_some_and(|v| i32::try_from(v).is_ok());
            let dy_ok = cmd["delta_y"]
                .as_i64()
                .is_some_and(|v| i32::try_from(v).is_ok());
            dx_ok && dy_ok
        }
        "TypeText" => cmd["text"]
            .as_str()
            .is_some_and(|s| s.chars().count() <= MAX_TYPE_TEXT_CHARS),
        "KeyPress" | "KeyDown" | "KeyUp" => cmd["key"].as_str().is_some_and(|k| {
            matches!(
                k,
                "enter"
                    | "backspace"
                    | "tab"
                    | "escape"
                    | "delete"
                    | "insert"
                    | "space"
                    | "home"
                    | "end"
                    | "pageup"
                    | "pagedown"
                    | "arrowup"
                    | "arrowdown"
                    | "arrowleft"
                    | "arrowright"
                    | "f1"
                    | "f2"
                    | "f3"
                    | "f4"
                    | "f5"
                    | "f6"
                    | "f7"
                    | "f8"
                    | "f9"
                    | "f10"
                    | "f11"
                    | "f12"
                    | "control"
                    | "alt"
                    | "shift"
                    | "meta"
                    | "capslock"
            )
        }),
        // Single Unicode character key press — used for modifier+key combos.
        "KeyChar" => cmd["char"].as_str().is_some_and(|s| s.chars().count() == 1),
        "Notify" => {
            let title_ok = cmd["title"]
                .as_str()
                .is_some_and(|s| s.chars().count() <= MAX_NOTIFY_TITLE_CHARS);
            let msg_ok = cmd["message"]
                .as_str()
                .is_some_and(|s| s.chars().count() <= MAX_NOTIFY_MESSAGE_CHARS);
            title_ok && msg_ok
        }
        // `ListDir` supports an omitted/empty path, which the agent treats as
        // "start at a sensible default" (typically the user's Documents folder).
        "ListDir" => true,
        "ReadFile" => cmd["path"].as_str().is_some(),
        "Mkdir" => {
            let path_ok = cmd["path"]
                .as_str()
                .is_some_and(|p| !p.trim().is_empty() && p.chars().count() <= MAX_FS_PATH_CHARS);
            let name_ok = cmd["name"]
                .as_str()
                .is_some_and(|n| !n.trim().is_empty() && n.chars().count() <= MAX_FS_NAME_CHARS);
            path_ok && name_ok
        }
        "RenamePath" => {
            let src_ok = cmd["src"]
                .as_str()
                .is_some_and(|p| !p.trim().is_empty() && p.chars().count() <= MAX_FS_PATH_CHARS);
            let dst_ok = cmd["dst"]
                .as_str()
                .is_some_and(|p| !p.trim().is_empty() && p.chars().count() <= MAX_FS_PATH_CHARS);
            src_ok && dst_ok
        }
        "CopyPath" => {
            let src_ok = cmd["src"]
                .as_str()
                .is_some_and(|p| !p.trim().is_empty() && p.chars().count() <= MAX_FS_PATH_CHARS);
            let dst_ok = cmd["dst"]
                .as_str()
                .is_some_and(|p| !p.trim().is_empty() && p.chars().count() <= MAX_FS_PATH_CHARS);
            src_ok && dst_ok
        }
        "DeletePath" => cmd["path"]
            .as_str()
            .is_some_and(|p| !p.trim().is_empty() && p.chars().count() <= MAX_FS_PATH_CHARS),
        "WriteFileChunk" => {
            let path_ok = cmd["path"]
                .as_str()
                .is_some_and(|p| !p.trim().is_empty() && p.chars().count() <= 2048);
            let total = cmd["total_chunks"].as_u64().unwrap_or(0);
            let idx = cmd["chunk_index"].as_u64().unwrap_or(0);
            let chunks_ok = total >= 1 && idx < total;
            let dv = &cmd["data"];
            let data_ok = dv.as_str().is_some() || dv.is_null();
            path_ok && chunks_ok && data_ok
        }
        "RequestInfo" | "RestartHost" | "ShutdownHost" | "LockHost" | "CollectSoftware" => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests;
