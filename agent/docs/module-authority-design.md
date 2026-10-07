# Device-local module authority and optional hardening

Design for review, 2026-10-04. Documentation only. **Selected product default: standard device-local approval with clear security limits.** Device UI/CLI enable modules; the server wire can only request stops. OS-protected storage, isolated remote execution and hardware presence are optional future hardening, not requirements for completing the current module feature.

## Selected default and honest limits

Device-local controls own grants. Remote configuration tunes already permitted sources and cannot grant a module. Revision-bound disable requests preserve duplicate/stale/conflict semantics; old command generations cannot legitimately gain a later regrant. Preserve existing enrollment UUID/history, grants, offline UI/CLI operation and lock-screen features. No mandatory hardware purchase, migration grant reset or lock-screen behavior change follows from this design.

“Device-local” describes where authorization is performed, not who physically operates the device. Today an operator with same-identity Files/Scripts/Terminal can alter local storage or invoke local controls. Remote input can drive the local UI or start desktop-user applications. A UI password adds a local access check but is not proof of physical presence; code executing as that user may bypass the UI. These limitations must be visible in product/security documentation. Do not claim that the default excludes all remote-origin enabling.

Keep local UI/CLI authentication consistent with the configured local policy. Fixing the known CLI/password-policy discrepancy is useful independently of OS isolation, but does not convert local authentication into physical presence. Local password recovery must remain offline and must not introduce a server override.

## Current source findings

These are inspected source facts, not installed-Windows ACL measurements.

| Area | Existing guarantee | Actual gap |
| --- | --- | --- |
| Persistence | [permissions.rs](../src/permissions.rs): default-off on missing/bad state, file lock, atomic replacement, Unix 0600 temp file/fsync, checked revisions and durable disable receipts. | Same-identity writers can replace JSON, roll back revisions/receipts or bypass the lock. Independent authority identity and trusted parent/link handling are absent. |
| Generation fences | Admission, workers and final outbound checks preserve original module revisions. | Checks trust the local store; the 100 ms cache is not an instantaneous physical-stop barrier. |
| Local controls | [ui.rs](../src/ui.rs) checks recent process-global password unlock for module changes when a password exists. | Empty password needs no unlock. [main.rs](../src/main.rs) `--module-permission MODULE on` calls `local_set` before role dispatch without that password check. UI `save_config` accepts replacement password/hash without equivalent backend unlock. Remote input can operate the UI. |
| Windows IPC | Normally SYSTEM/admin/console-user pipe DACL; some verbs compare caller image path. | [service/pipe_server.rs](../src/service/pipe_server.rs) falls back to Authenticated Users on console SID failure. `PersistConfig` writes an entire supplied config as SYSTEM without caller-role/operation authorization. Image equality is not authorized launch identity; generic frames/control messages enter through IPC. |
| Windows update | [service_client.rs](../src/service_client.rs) verifies downloaded MSI bytes with minisign. | Service `install_msi` does not require `caller_trusted` and checks staging path/extension without revalidating signature at the privileged boundary. Another pipe caller can bypass the client check. Actual staging-write exploitability depends on installed ACLs. |
| Stop acknowledgment | Durable revoke precedes success; local drain reports `persisted`, `stopped:false` and descriptive `stop_status`. | Worker registries are process-local; synchronous coverage is incomplete. Timeout, lost pipe or empty local registry does not prove global shutdown. |

`available()` currently marks all canonical modules available; keep platform capability separate from grants. Linux Wayland remote input remains unsupported.

### Linux

[README](../packaging/linux/README.md) installs a user-owned binary in `~/.local/bin`; [user service](../packaging/linux/vantyr-agent.service), config and permissions share the desktop UID. `NoNewPrivileges`/`ProtectSystem=full` do not protect that user's own files. Arch installs `/usr/bin/vantyr-agent` while the unit still references `%h/.local/bin/vantyr-agent`.

Standalone [PTY terminals](../src/platform/linux/terminal.rs), [scripts](../src/remote_script.rs) and [file commands](../src/server_command.rs) inherit the agent identity. Authorized code can rewrite grants/config/startup, invoke the CLI or replace the user-installed binary. X11 input can launch desktop-user programs; terminal isolation alone would not prevent this. Any future remote executor must exclude desktop `input` membership, display/DBus sockets and privileged devices.

### Windows

[role.rs](../src/role.rs), [service/session_launch.rs](../src/service/session_launch.rs) and [MSI template](../wix/templates/main.noshortcuts.wxs): service is LocalSystem; companion uses the interactive WTS user token; [CaptureWorker](../src/capture_worker.rs) runs SYSTEM in the console session and follows input desktops including Winlogon. Standalone inherits its launcher, potentially elevated. [ConPTY](../src/terminal.rs) and scripts inherit the caller token, without a remote-specific restricted identity.

[config.rs](../src/config.rs) puts machine-DPAPI config and adjacent permission state in ProgramData. The inspected installer does not explicitly provision/verify a dedicated authority-directory DACL. Machine DPAPI does not authorize callers; readable machine-scoped ciphertext can be decrypted by another local user ([Microsoft](https://learn.microsoft.com/en-us/windows/win32/seccrypto/example-c-program-using-cryptprotectdata)). File ACLs alone would not fix the SYSTEM whole-config proxy. SYSTEM secure-desktop input also limits any future physical-consent claim; default lock-screen behavior remains unchanged.

## Optional next slice: privileged IPC/update hardening

This is a concrete independently reviewable improvement, not a dependency on hardware or a prerequisite for calling the current protocol module feature complete. Preserve local grant/connection/password workflows and grant/history identity.

1. Replace whole-config `PersistConfig` with bounded typed operations and explicit replies. Presentation preferences cannot change grants, password, token/UUID, update trust or policy authorization. Password/connection changes have separate local authorization and audited recovery. Inventory every current caller before removing the legacy verb; do not add a generic compatibility bypass.
2. Register service-launched companion/worker/updater roles using held process identity and private inherited channels/capabilities. Apply per-verb authorization. Image path is corroboration, not proof. Reject generic worker-origin authority reports/acks; originate them through the authority owner. Same-user injection/capability theft remains a limitation until stronger identity/process separation.
3. Harden pipes: local-only, explicit role-specific DACLs, no Authenticated Users fallback, first-instance namespace protection, bounded framing, and client verification of the service. SID lookup failure disables the affected endpoint with actionable status. Retain a separately authenticated local-control path; transport/updater roles have no local-enable verb.
4. Reverify update signatures/pinned release metadata inside the service. Accept an authenticated artifact request, not an arbitrary MSI path. Copy verified bytes into private service-owned staging and prevent swaps through install. If clients cannot write private staging, stream bounded candidate bytes into quarantine rather than weakening ACLs. Reject unsigned/wrong-key/changed artifacts and test lifetime across service-stop/install transitions.

| Exact proposed files | Scope |
| --- | --- |
| `agent/src/service/`, `agent/src/ipc.rs` | Typed verbs/replies, launch roles/private channels, pipe and caller checks. |
| `agent/src/config.rs`, `agent/src/ui.rs`, `agent/src/main.rs` | Adapt local persistence/authentication and offline recovery; preserve enabling. |
| `agent/src/service_client.rs`, `agent/src/updater_manifest.rs` | Artifact request and shared service-side signature/metadata validation. |
| `agent/src/ws_client.rs` | Authority-message origin checks; preserve original generations. |
| `agent/wix/templates/main.noshortcuts.wxs` | Explicit private-staging/resource ACLs and upgrade preservation. |
| NEW `agent/src/service_authorization.rs`, NEW `agent/src/service_update.rs` | Small role/verb policy and verified-artifact helpers with fixture tests. |

Risks: whole-config callers, password consistency, WTS switches/PID reuse/handle inheritance, artifact loss during shutdown and MSI ACL ordering. Fixture tests cover policy/bytes; actual pipe/token/install behavior requires a disposable Windows VM. No shared DB or real device state mutations for tests.

## Optional OS-protected store and lower-privilege execution

Target a narrower enforceable claim: **isolated remote execution cannot rewrite grants or exploit privileged proxies**. This does not automatically prevent remote input or arbitrary desktop-user code from using authorized local controls. Trust kernel, broker and verified install/update chain; malicious root/local administrators remain outside the boundary.

A small broker is the sole writer. Linux uses root-owned installed binaries/system unit, `/var/lib/vantyr/authority` and `/run/vantyr` sockets. Windows uses a dedicated service identity/SID and explicit protected directory/file DACLs. Validate fixed-root ancestor/target handles, ownership/type, symlink/reparse/hardlink and atomic-replacement ACL behavior. chmod or a permission-file denylist alone is insufficient.

Keep schema1 and external module/revision generations. An internal envelope adds format version, authority epoch, UUID, revisions, receipts and audit; worker capabilities bind boot/instance/connection. No revision reset or legacy-store fallback on failure. IPC obtains kernel peer credentials on Linux and connected-caller token/logon/session/service identity on Windows, with held process references/private launch channels. Caller-supplied PID/role/path is not proof. Typed read/revoke/dispatch/worker verbs cannot enable; a distinct authenticated local UI/CLI operation can. Operation-scoped unlock improves replay handling without claiming physical presence.

Linux remote files/shell/scripts use a dedicated UID, no supplementary groups/capabilities, `no_new_privs`, sanitized environment/handles, service-owned cgroups and scoped filesystem/device/socket access. Landlock can add defense in depth with ABI checks ([kernel](https://www.kernel.org/doc/html/latest/userspace-api/landlock.html)). Windows uses a dedicated account or restricting-SID token, removed privileges, scoped ACLs and job assignment before child resume. Lower integrity/admin deny-only alone is insufficient ([Microsoft](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens)). Apply the boundary to files, PTY/ConPTY and scripts, including elevated launches; no silent parent-token fallback.

Approved data roots require link/rename-resistant handle resolution. Reduced filesystem access is an owner-visible compatibility decision, not a silent workspace restriction. Privileged system/network/app-policy helpers accept typed fresh-authorized operations, never arbitrary executables/paths. Inventory/log readers remain bounded; source configuration is tune-only.

Later exact areas: NEW `agent/src/module_authority/{protocol,store,broker,client,linux,windows}.rs`, executor adapters/tests and Linux system unit; existing `permissions.rs`, `main.rs`, `config.rs`, `ui.rs`, `service.rs`, `ipc.rs`, `ws_client.rs`, `server_command.rs`, `remote_script.rs`, `platform/linux/terminal.rs`, `terminal.rs`, `process_tree.rs`, packaging/MSI. Implement/test one OS vertical slice at a time before advertising protection.

## Completion, upgrades and owner recovery

Persist revoke first, fence old-generation dispatch/egress, then cancel. Cross-process registration must precede start and serialize with revoke; authenticate worker completion by instance/module/generation and held OS reference. Report pending participants/timeouts honestly. `stopped:false` stays until coverage and OS-confirmed descendant completion justify a stronger fact. Completed writes/input/audio/policy effects are not rolled back; drained workers do not prove every external effect ceased.

Default updates preserve grants and offline controls. Optional protected migration validates bounded legacy input and shows an owner-reviewed import/repair plan; no automatic mandatory disabling. Preserve UUID/enrollment/history, revision high-water and receipts. Unverifiable state requires explicit owner repair, not silently trusted forged grants or revision reset. Import once; prevent old-writer downgrade/fallback. Test actual install/major-upgrade ownership/ACLs.

Device UI/CLI inspect/enable/revoke and local credential recovery work without the server. Narrow OS-admin recovery preserves identity/revisions and offers explicit grant choices; it is administrative trust, not physical proof. Broker failure must leave login, documents, service stop and uninstall usable. No mandatory hardware enrollment or hardware-loss procedure applies to the selected default.

## Optional stronger-presence research

Requires separate user selection. Compare OS-authenticated prompts, protected desktop/session, temporary remote-input suspension and hardware UP/UV; passwords alone are remotely automatable. FIDO2 is a candidate, not the selected policy or proof of location by itself.

A research prototype would bind one-use proof to exact device/module/revision/helper/session/deadline and display that operation on a trusted path. Linux physical VT/device access and Windows private-desktop/authenticator API feasibility need VM/hardware verification, including RDP/USB redirection. If secure-desktop input conflicts, propose temporary fencing or restrictions with explicit lock-screen tradeoff approval. Do not change default lock-screen behavior or require hardware as a module acceptance gate. Recovery/enrollment usability must be resolved before an optional rollout.

## Verification by scope

- **Current/default:** wire/config cannot grant; device-local enable works under configured policy offline; disable duplicate/stale/conflict and delayed-generation races pass. Document same-identity code/input bypasses rather than asserting physical-only consent.
- **IPC/update slice:** reject wrong role/launch, unknown/oversized frames, whole-config/password bypass and authority-frame forgery; legitimate local flows still work. Service rejects unsigned/wrong-key MSI and staging swaps. Verify actual Windows pipe/staging ACLs and session/handle behavior.
- **Optional OS boundary:** with Files/Scripts/Terminal granted, real isolated workers attempt JSON/lock/config/binary/startup/update writes, CLI enabling, IPC impersonation and link/rename escapes; authority state is unchanged or access explicitly denied. Include elevated launch/descendants, crash/revision/migration tests and offline local recovery. Test local-control/input residual exposure separately.
- **Shutdown:** multiple processes, delayed/lost completion and synchronous work produce prompt durable revoke/egress fencing with honest pending/unconfirmed status; no rollback claims.
- **Optional presence:** only if selected, test proof replay, absent/wrong hardware, redirected sessions/input injection and failed worker fencing; verify valid ceremony/recovery offline with real hardware/console, not a mocked boolean.

All tests use temporary fixtures or disposable VMs. Release the protocol feature with its stated limits; optional hardening adds independently verified claims without redefining the selected default.
