# Exclusive remote control

Dashboard WebSockets acquire one lease per connected agent. The server binds it to the authenticated user UUID, server-generated viewer connection UUID, and current agent connection UUID. Reconnecting either socket fences old tokens. Admins cannot steal a lease.

Viewer messages:

```json
{"type":"control_acquire","agent_id":"UUID","request_id":"UUID"}
{"type":"control_heartbeat","agent_id":"UUID","request_id":"UUID","lease_token":"UUID"}
{"type":"control_release","agent_id":"UUID","request_id":"UUID","lease_token":"UUID"}
{"type":"control","agent_id":"UUID","lease_token":"UUID","cmd":{"type":"MouseMove","x":100,"y":200}}
```

`control_lease` replies contain `agent_id`, matching `request_id`, `status` (`granted`, `released`, `denied`), and `expires_in_ms`. Only `granted` replies contain `lease_token`; denials contain `code` and `error`. Acquire is idempotent for the same owner without extending the deadline. Heartbeat extends from now by 15,000 ms; the underlying state machine caps TTL at 30,000 ms. No caller-supplied TTL is supported.

Asynchronous revocation is private to the owning viewer: `{"event":"control_lease","status":"revoked","agent_id":"UUID","lease_token":"the revoked token","expires_in_ms":0,"code":"control_lease_expired|control_lease_revoked"}`. It has no `request_id`. Explicit release replies use `released`, without a second revocation event. Private broadcast Debug output redacts payloads.

All remote-input commands, including `Notify`, require a token. Missing tokens yield `command_rejected` with `control_lease_required`; other lease errors are `control_conflict`, `control_lease_expired`, and `control_lease_mismatch`. Shape validation, operator/admin permission, current module availability/local grant, pending disable, and legacy capability checks still apply. Known unsupported capabilities yield `capability_unavailable`; absent legacy metadata retains its previous attemptable behavior. Capability lookup happens outside the control mutex and is cached per agent connection. Files/system commands retain their existing checks.

Expiry sweeps every 250 ms, including idle periods. Viewer disconnect, agent disconnect/replacement/credential rotation, remote-input permission generation change, and pending module disable revoke leases. Dashboard sessions are revalidated every 5 seconds with a 3-second query timeout; expired/deleted sessions close the viewer, and role downgrades revoke control. DB check failure closes the viewer conservatively.

The lock order is lifecycle gate, control integration mutex, agent connections, module state, command senders. No parking_lot guard crosses an await. Authorization, held-input tracking, cleanup enqueue, and new input enqueue are serialized. Normal queue entries retain their existing module generation fences. Held input uses a fixed key bitset and three mouse-button slots. Cleanup is a server-only queue variant restricted to known KeyUp/MouseUp commands and fenced to the exact old socket. Cleanup enqueue failure or input enqueue failure signals out-of-band socket shutdown and blocks further grants/delivery on that connection. Lease and input audit writes are throttled and capped at 64 concurrent tasks and 4,096 throttle entries; tokens/envelopes are never audited.

Cleanup bypasses server module authorization only for releases. The agent can still deny wire releases after a local revocation; its existing periodic revocation cleanup independently releases held inputs. Physical release behavior, OS input injection, and disconnect cleanup have not been verified on real hardware in this stage. APP15 geometry bytes and optional capture/geometry input fields are preserved, but frame extraction and multi-viewer monitor arbitration remain separate work.
