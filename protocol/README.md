# vantyr-protocol

The wire protocol shared by the Vantyr server (`server/`) and the endpoint agent (`agent/`).
Both compile this crate, so a command name, field or limit is defined once. It depends only on
`serde`, `serde_json` and `uuid`, with no OS-specific or runtime dependencies, because the server
builds it natively and the agent builds it for Windows and Linux.

The server is a member of the root Cargo workspace (`cargo test --workspace` runs this crate's
tests). The agent is built separately and depends on it by path: `vantyr-protocol = { path = "../protocol" }`.

## What lives here

| Module | Contents |
| --- | --- |
| `modules` | `Module` (the device-owned capability catalogue) and `MODULES`. |
| `commands` | `ServerCommand`: every server -> agent command, tagged by `"type"`, with its payload structs and `ServerCommand::gate`, the one command -> authorization table (`Gate::Module(m)`, `Protocol`, `DisableModule`, `Denied`). The agent admits commands by it and the server authorizes sends by it. |
| `agent_message` | `AgentMessage`: the agent -> server frames the server dispatches on, plus the few fields it reads to route or validate them. |
| `recall_context` | The Recall foreground context (`Context`, `Status`, `Reason`, `Source`) and its limits, shared by the agent that builds it and the server that re-validates it. |
| `frames` | Magic prefixes of binary frames (`HST\0` Recall keyframe, `AUD\0` audio). |
| `telemetry` | The one strict set of agent telemetry payloads the server binds. |
| `error` | `ProtocolError`: code-only rejection reasons, never raw frames or secrets. |

The `ts` cargo feature (off by default, enabled by the server) derives `ts_rs::TS` on the few wire
types the dashboard also reads (`Module` and the Recall context vocabulary) so their TypeScript is
generated; the agent never enables it. See `server/docs/ARCHITECTURE.md`.

What stays out: payloads only one side interprets (remote-input `ControlCommand`, module reports,
telemetry bodies, policy rules). Those remain raw JSON here and are parsed where they are used.

## One current contract

This is one current application. There are no parallel legacy/current readers, no silent
compatibility fallbacks and no tolerance for stale or malformed peers.

- Wire strings never change. They are the current contract, not a versioned compatibility layer.
- `ServerCommand::try_parse` and `AgentMessage::try_parse` are strict: an unknown `"type"`, a
  missing required field or a wrongly-typed field is an error and the receiver drops the frame
  before any mutation, RPC completion or fan-out. `parse()` is retained only as a
  signature-compatible fallback; its `Unknown` result is denied at every owned boundary.
- Security fields are required and bound: `disable_module` carries `module`, `expected_revision`
  and `command_id`; gated commands carry `__module_generation`. A missing stamp is never
  synthesized on the agent. A bad field never becomes an authorization default.
- `Option` means the current sender legitimately emits `null` or omits the field (for example
  `user`, `app_display`, capture tunables). It is not a compatibility default. Internal stamp
  fields (`__module_generation`, `__window_generation`, `__clipboard_session`) are allowed extra
  fields; unknown extras are ignored, but known fields are strictly typed.
- `Gate`/`gate_for_kind` is the single authorization table. `Gate::Protocol` commands bypass
  module checks; `Gate::DisableModule` and all module-gated commands still require current
  authorization. Capability negotiation, generation fences, cancellation and replacement stay.
- Errors are code-only (`ProtocolError`): no raw frame, clipboard text or token may reach logs.
- Round-trip tests pin the exact JSON of every command the server builds
  (`commands::tests`); update them deliberately, never to make a failure go away. Old
  compatibility expectations are replaced by rejection regressions.
