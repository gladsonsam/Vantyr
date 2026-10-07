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
| `lenient` (private) | Field readers that treat a missing or wrongly-typed field as absent. |

What stays out: payloads only one side interprets (remote-input `ControlCommand`, module reports,
telemetry bodies, policy rules). Those remain raw JSON here and are parsed where they are used.

## Compatibility rules

Agents and servers are upgraded independently, so a change must keep working against the other
side's previous release.

- Wire strings never change. Add new commands, message types and fields; do not rename or remove them.
- Receivers tolerate the unknown. An unknown `"type"` parses as `ServerCommand::Unknown` /
  `AgentMessage::Unknown` (the receiver logs it; the server still fans an unknown agent message out to dashboards), unknown fields are ignored, and a
  missing, `null` or wrongly-typed field reads as absent. Never reject a whole frame over one field.
- Senders omit what they did not set. Optional fields use `skip_serializing_if = "Option::is_none"`
  so an old receiver sees exactly the frame it always saw. A new required piece of data is a new
  optional field with a default, not a new mandatory one.
- Do not add `deny_unknown_fields` to anything an older peer may send fields for.
- A new gated command goes into `ServerCommand::gate` in the same change. Gate semantics are
  security-relevant: `Gate::Protocol` commands bypass module checks on both sides.
- Round-trip tests pin the exact JSON of every command the server builds
  (`commands::tests`); update them deliberately, never to make a failure go away.
