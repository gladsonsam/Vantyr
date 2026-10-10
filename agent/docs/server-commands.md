# Server -> agent commands

Every command the server sends an agent is a WebSocket text frame holding a JSON object tagged by `"type"`. The wire strings mix PascalCase and snake_case and must stay exactly as listed. The typed form is `ServerCommand` in the shared [`vantyr-protocol`](../../protocol/src/commands.rs) crate (re-exported as [`commands::protocol`](../src/commands/protocol.rs)); [`commands/mod.rs`](../src/commands/mod.rs) parses, gates and dispatches it to the per-area handlers next to it.

## Path of a command

1. [`connection/ws_client/connection.rs`](../src/connection/ws_client/connection.rs) (service-owned socket): `agent_deleted` / `agent_credentials_revoked` park the connection in Error; `disable_module` is answered on the spot (never forwarded); everything else must pass `permissions::admit_command`, which stamps `__module_generation` for gated commands. `ClipboardRead` / `ClipboardWrite` also get a local `__clipboard_deadline_ms` (and on Windows `__clipboard_session`).
2. Windows: [`host/service/companion.rs`](../src/host/service/companion.rs) routes clipboard commands to the owning console session, then writes each command down the IPC pipe. The SYSTEM [`capture/worker.rs`](../src/capture/worker.rs), also on that pipe, handles `start_capture` / `stop_capture` and remote input itself; the user-session companion skips those (`role::suppresses_capture_and_input`).
3. [`connection::agent_loop`](../src/connection/agent_loop/session.rs) consumes `history_frame_ack` and hands the rest to `commands::handle_server_command`.
4. The dispatcher drops a gated command whose generation is missing or for another module, runs clipboard / `disable_module` before the local module fence, then checks `permissions::command_allowed` (which denies unknown types) and dispatches. Remote input goes to the session's `InputController` as raw JSON.

## Module gates

`ServerCommand::gate` (in `vantyr-protocol`) is the single command -> authorization table, shared with the server; `permissions::command_module(kind)` reads it. A command is `Gate::Module(m)` (gated), `Gate::Protocol` (non-collecting, passed through), `Gate::DisableModule` (the agent accepts it ungated and answers it itself; the server only sends one that matches a persisted disable request) or `Gate::Denied`. A gated command needs the module granted locally and a matching generation. An ungated command is allowed only if `permissions::fence` lists it as a non-collecting protocol command; any other type (including the remote UI-password setter) is denied.

## Commands

Replies are built from the typed structs in [`outbound/replies.rs`](../src/outbound/replies.rs). Field types are what the agent reads. Every field is lenient: missing, `null` or the wrong JSON type is treated as absent and takes the listed default (or makes the handler ignore the command), never a parse failure of the whole frame.

| `type` | Fields (default) | Module | Handler | Reply |
| --- | --- | --- | --- | --- |
| `agent_deleted`, `agent_credentials_revoked` | - | - | `mod.rs` (log) | - |
| `disable_module` | `module`, `expected_revision`, `command_id` (raw JSON) | - | `permissions::disable_and_wait` | `module_disable_ack` |
| `history_frame_ack` | `uid`, `rejected`, `reason` (raw JSON) | - | `agent_loop::history` | - |
| `ClipboardRead` | `request_id` (UUID) (raw JSON) | `clipboard` | `crate::input::clipboard` | `clipboard_result` |
| `ClipboardWrite` | `request_id` (UUID), `text` (raw JSON) | `clipboard` | `crate::input::clipboard` | `clipboard_result` |
| `ClipboardCancel` | `request_id` (UUID) (raw JSON) | - | `crate::input::clipboard` | - |
| `TerminalStart` | `session_id` UUID (else ignored), `cols` (80, 2-500), `rows` (24, 1-200) | `terminal` | `terminal.rs` | `terminal_output`, `terminal_exit` |
| `TerminalInput` | `session_id`, `data` (else ignored) | `terminal` | `terminal.rs` | - |
| `TerminalResize` | `session_id`, `cols`, `rows` as `TerminalStart` | `terminal` | `terminal.rs` | - |
| `TerminalClose` | `session_id` | - | `terminal.rs` | - |
| `RequestInfo` | - | `system_info` | `info.rs` | `agent_info` |
| `CollectSoftware` | - | `software_inventory` | `info.rs` | `software_inventory` |
| `LockHost`, `RestartHost`, `ShutdownHost` | - | `system_control` | `power.rs` | - |
| `update_now` | - | - | `update.rs` -> `windows.rs` (Windows only) | `notify` |
| `set_auto_update` | `enabled` bool (else ignored) | - | `policy.rs` | - |
| `set_network_policy` | `blocked` bool (false) | `network_policy` | `policy.rs` | - |
| `set_internet_block_rules` | `rules` array ([]); unparseable rules skipped | `network_policy` | `policy.rs` | - |
| `set_recall_settings` | `settings` object (`HistorySettings`; malformed -> whole update ignored) | - | `policy.rs` | - |
| `set_app_block_rules` | `rules` array ([]); unparseable rules skipped | `app_policy` | `policy.rs` | - |
| `start_capture` | `jpeg_quality` / alias `jpeg_q` (40, 1-100); `interval_ms` int or float, else 1000/`fps` (200, 33-2000); `monitor` / alias `monitor_index` (primary) | `live_screen` | `capture.rs`, `capture/worker.rs` | binary frames |
| `stop_capture` | - | - | `capture.rs`, `capture/worker.rs` | - |
| `start_audio` | - | `live_audio` | `capture.rs` -> `windows.rs` (Windows only) | binary frames |
| `stop_audio` | - | - | `capture.rs` | - |
| `ListLogSources` | `request_id` (trimmed; empty -> ignored) | `logs` | `logs.rs` | `log_sources` |
| `ReadLogTail` | `request_id` (as above), `kind` (`local_agent`, 64 chars), `max_kb` (512, max 2048) | `logs` | `logs.rs` | `log_tail` |
| `ListDir` | `path` (empty -> Documents, `__this_pc__` -> drives / mounts; 1024 chars) | `files` | `files/mod.rs` | `dir_list` |
| `ReadFile` | `path` (2048 chars) | `files` | `files/transfer.rs` | `file_chunk` (3 MiB raw per chunk) |
| `WriteFileChunk` | `path`, `total_chunks` (0), `chunk_index` (0), `data` base64 ("") | `files` | `files/transfer.rs` | `file_upload_result` (errors, and success on the last chunk) |
| `Mkdir` | `request_id`, `path`, `name` (no separators); any empty -> ignored | `files` | `files/mod.rs` | `fs_op_result` (`op: mkdir`) |
| `RenamePath` | `request_id`, `src`, `dst`; any empty -> ignored | `files` | `files/mod.rs` | `fs_op_result` (`op: rename`) |
| `CopyPath` | `request_id`, `src`, `dst`; any empty -> ignored; files only | `files` | `files/mod.rs` | `fs_op_result` (`op: copy`) |
| `DeletePath` | `request_id`, `path`, `recursive` (false) | `files` | `files/mod.rs` | `fs_op_result` (`op: delete`) |
| `RunScript` | `request_id` (empty -> ignored), `shell` (`powershell`, lowercased), `script` (max 256 KiB), `timeout_secs` (120, 5-300) | `scripts` | `scripts/` | `script_result` |
| `MouseMove` | `x`, `y` | `remote_input` | `input.rs` -> `input::remote::command::ControlCommand` | - |
| `MouseClick`, `MouseDoubleClick`, `MouseDown`, `MouseUp` | `x`, `y`, `button` (`left` / `right` / `middle`, default `left`) | `remote_input` | as above | - |
| `MouseScroll` | `delta_x`, `delta_y` (clamped to 20 notches) | `remote_input` | as above | - |
| `Scroll` | gated like input but not a `ControlCommand`, so always rejected | `remote_input` | as above | - |
| `KeyDown`, `KeyUp`, `KeyPress` | `key` (`SpecialKey`, lowercase) | `remote_input` | as above | - |
| `KeyChar` | `char` | `remote_input` | as above | - |
| `TypeText` | `text` (max 2000 chars) | `remote_input` | as above | - |
| `Notify` | `title` (64), `message` (256); Windows toast only | `remote_input` | as above | - |

Remote input is the one strictly typed payload: `ControlCommand` in [`input/remote/command.rs`](../src/input/remote/command.rs) rejects a command with missing or mistyped fields. Mouse commands may also carry `capture_id` / `geometry_revision`, which [`capture/geometry.rs`](../src/capture/geometry.rs) checks against the current capture before mapping `x` / `y` to desktop coordinates.

Internal fields the agent adds or reads besides the above: `__module_generation` (admission binding), `__clipboard_deadline_ms` and `__clipboard_session` (clipboard routing), `__input_session` (capture worker input thread).
