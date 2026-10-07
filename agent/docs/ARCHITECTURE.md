# Agent architecture

The agent is one binary (Tauri 2 on Windows, headless on Linux). `main.rs` only declares the top-level modules and hands the command line to [`host::run`](../src/host/mod.rs), which picks the process role and starts it.

## Layout

```
main.rs          module list + `host::run(Launch::from_args(..))`
host/            process roles and startup: launch (arg parsing), agent (runtime thread + UI),
                 logging, role, log_sources; Windows only: service/, ui/, ipc, service_client,
                 single_instance
connection/      talking to the server: agent_loop/ (session, history upload, URL polling,
                 transport), ws_client, reconnect, enrollment/; Windows only: mdns
commands/        server -> agent commands: protocol (re-exports the typed ServerCommand from the shared
                 protocol/ crate) + one handler per area (see server-commands.md)
permissions/     local module grants, generations and the outbound fence (used by every feature)
policy/          parental controls: app_block/, network/ (kill-switch + curfew scheduler), schedule
capture/         screen/ (live stream), history/ (Recall keyframes + spool), recall_context/,
                 geometry (capture/input authority); Windows only: worker, secure_desktop, audio
input/           remote/ (mouse/keyboard injection, notifications), clipboard/ (+ session routing)
inventory/       system_info/ (agent_info, metrics), software/ (installed programs)
config/          Config, AgentStatus and the per-OS config store
updater/         Windows only: release manifest, MSI staging, minisign verification
platform/        OS capabilities shared across features (see below)
```

The wire types shared with the server (`Module`, `ServerCommand`, `AgentMessage`, the Recall context types, frame magics) live in the in-repo [`protocol/`](../../protocol/README.md) crate, a path dependency of the agent. `permissions::modules`, `commands::protocol` and `capture::recall_context` re-export them; agent-only behaviour on those types (`ContextExt`, grant checks) stays here.

`permissions/` stays top-level rather than under `policy/`: it is the module-authority gate every feature consults (hundreds of call sites), not a parental-control policy.

## Where OS-specific code goes

One rule decides it:

- **A capability used by several features, or one that is nothing but OS code, lives behind `platform/`.** The facade in [`platform/mod.rs`](../src/platform/mod.rs) re-exports each capability from the backend built for the target, and the real code is in `platform/windows/<capability>.rs` and `platform/linux/<capability>.rs`. [`platform/contract.rs`](../src/platform/contract.rs) pins every entry point's signature so the two backends cannot drift, and [`platform/types.rs`](../src/platform/types.rs) holds the OS-neutral types they return. Today: `activity_tracker`, `keyboard_monitor`, `process_tree`, `system_control`, `terminal`, `url_provider`. Windows-only helpers they share (`app_display`, `app_icons`) are private modules of `platform/windows/`; Linux session detection is `platform::linux::session`.
- **OS code used by one feature stays in that feature** as `feature/windows.rs` and `feature/linux.rs` next to the feature's `mod.rs`, which holds everything OS-neutral. Examples: `config/` (DPAPI store vs XDG JSON), `capture/screen/` (input-desktop following vs Wayland/X11 paths), `inventory/system_info/`, `policy/network/` (netsh vs nftables), `commands/scripts/` (PowerShell/cmd vs sh/bash).
- **A module that only exists on one OS** (the Windows service, settings UI, capture worker, audio, updater, mDNS, ...) is gated once, on its `mod` declaration in the parent. Nothing inside it is gated again.

Feature `mod.rs` files select their backend the same way everywhere:

```rust
#[cfg(not(windows))]
mod linux;
#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
use self::linux as imp;
#[cfg(windows)]
use self::windows as imp;
```

and then call `imp::…` unconditionally. Because the shared code calls the same functions on both targets, a backend that is missing a function or has a different signature fails that target's build; no extra contract is needed for feature-local code. When one side has nothing to do, it gets a no-op with a comment saying why (e.g. Linux `enrollment::try_auto_discover_and_request_access`), rather than a `#[cfg]` at the call site.

## Gate predicates

Use `#[cfg(windows)]` / `#[cfg(not(windows))]` only. "Not Windows" means Linux: the agent builds for no other OS. Keep `#[cfg(unix)]` for code that is genuinely about Unix semantics regardless of the target's OS family (file modes and directory fsync in [`permissions/store.rs`](../src/permissions/store.rs)). `#[cfg(any(windows, test))]` marks Windows logic that is also unit-tested on Linux (`input::clipboard::session`).

Do not put `#[cfg]` inside function bodies. If a function needs a per-OS step, move that step into the feature's `windows.rs` / `linux.rs`.

## Process roles

`host::run` dispatches on the command line:

| Flag | Role | Where |
| --- | --- | --- |
| `--module-permission [module on\|off]` | print or set a local module grant, then exit | `host/mod.rs` |
| `--import-machine-config <json>` | write the config, then exit | `host/mod.rs` |
| `--service` | LocalSystem service in Session 0: owns the server WebSocket and privileged requests | `host/service/` |
| `--capture-worker` | SYSTEM process in the console session: live capture and remote input, including the lock screen | `capture/worker.rs` |
| `--service-managed` | companion in the user session: telemetry, settings UI; capture/input delegated to the worker | `host/agent.rs` + `host/role.rs` |
| (none) | standalone agent; on Linux always this | `host/agent.rs` |

The companion and the service talk over the IPC pipe in [`host/ipc.rs`](../src/host/ipc.rs); privileged requests (MSI install, firewall, log truncation) go over the service pipe via [`host/service_client.rs`](../src/host/service_client.rs).
