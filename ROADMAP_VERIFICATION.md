# Roadmap verification

`roadmap.json` tracks implementation, evidence, and remaining limitations. A passing demo or mocked browser test does not establish hardware behavior. Record the tested commit, OS/build, browser, device, monitor configuration, and network conditions for each hardware run below.

## Current automated baseline

At commit `a9ba579`, the frontend passed 151 tests in 33 files, full lint, and a production build. The server passed 94 default tests plus 16 PostgreSQL integration tests with isolated temporary tables. Server `cargo check` and formatting passed. Database tests require both `TEST_DATABASE_URL` and `RECALL_TEST_DATABASE_URL`; neither should point at production.

Headless Chromium demo checks at 320px and 390px verified favorites filtering, saving a fleet view, navigation to Recall, OCR search results, and a saved bookmark note. Document width equaled viewport width. Browser errors were empty. Reload interaction and real phones remain unverified. The main app bundle is 74.47 kB (21.44 kB gzip), with feature pages loaded separately; this is a build measurement, not a measured mobile load time.

## Fleet and reset

1. Enroll devices named `Laptop 2`, `Laptop 10`, and `Laptop 1`; take one offline. Confirm online devices precede offline devices and names sort naturally. Generate AFK and blocking events; default connectivity ordering must remain stable.
2. Favorite a device and save a view with search, status, list/grid, sort direction, and favorites filter. Reload and apply it. Sign in as another user or change server; the first user's preferences must not appear.
3. Remove a device from grid and list. Delay or fail the request: confirmation and selection remain, the error is visible, and retry works. Successful removal clears selected-device routes and other open dashboards.
4. Replace an installation using a UUID-bound code. Confirm identity, name, history, and settings remain. The previous credential cannot reconnect. Reuse and expiry of the replacement code must fail.
5. Reinstall with ordinary unbound enrollment and the same hostname. It must not inherit the old UUID or history without explicit replacement.

## Device modules and local authority

The selected product policy is standard device-local approval: laptop UI/CLI enables, server protocol only stops. Hardware authentication and isolated remote execution are not default requirements.

1. Start with fresh local permission storage. Each optional module is disabled until enabled locally. The server UI offers stop/retry and explains local enablement.
2. Enable Recall locally; observe recordings. Stop it from the server. Verify persisted revocation and generation changes separately from physical worker-stop confirmation.
3. Disconnect the device, queue a stop, then reconnect. Confirm the same command is replayed and correlated. Retry uses the original command UUID and expected module revision.
4. After stopping, enable locally again and replay the old stop command. The new grant must remain enabled. A new stop requires a new command UUID and current module revision.
5. Run simultaneous local processes. Revoke during capture, upload, queued input, terminal, and script work, then immediately re-enable. Old-generation work must not resume under the new grant.
6. Attempt to rewrite permission storage using authorized remote files, terminal, and scripts; attempt to enable a module through remote input. **These are documented limits of the user-selected standard device-local approval mode.** A stronger optional mode would require protected authority and lower-privilege execution; the standard mode does not claim physical-presence security.
7. Test shutdown of descendants and blocked OS workers on each supported OS. Persisted revocation alone must never be reported as confirmed physical shutdown.

## Exclusive remote control

1. Open two authenticated operator browsers on one device. Browser A acquires control. B receives a clear conflict and sends no accepted input. Admin status must not permit stealing A's lease.
2. Hold a modifier and mouse button, then blur, hide, close, disconnect, or release A. Observe actual OS input state returning to released. Repeat with a lost heartbeat and server expiry.
3. Reconnect either viewer or agent and replay the old token. It must be rejected. Test a replacement connection while old cleanup is pending; cleanup cannot target the replacement socket.
4. Revoke the remote-input module and downgrade/delete/expire the dashboard session. Confirm revocation feedback and OS input cleanup. A blocked database check must close the viewer conservatively.
5. Saturate the agent command queue. Failure to enqueue input or cleanup closes the exact agent socket and prevents successor control on that connection.

## Geometry and multiple viewers

1. Use two monitors, including a negative desktop origin, portrait orientation, and mixed DPI. Click all corners, center, and letterbox margins. Only the displayed image maps to physical screen coordinates.
2. Change monitor, resolution, scale, or orientation during a drag and during delayed frame decoding. Held inputs release; old capture IDs/revisions cannot authorize new input.
3. Inject missing, malformed, duplicate, and mismatched JPEG metadata. The UI must not invent absolute coordinates. Displayed geometry must come from the displayed frame, never a newer undecoded frame.
4. While A controls, have B request another monitor or change capture tuning. A's display cannot silently switch. Test B's disconnect and lease expiry as well as explicit monitor/default-primary requests.
5. Exercise secure desktop, monitor hotplug, and capture restart. Record supported behavior per OS; Wayland physical mapping remains an explicit unresolved case.

## Mobile and Recall

1. On real iOS Safari and Android Chrome, test 320–430px portrait widths, landscape rotation, browser zoom, safe-area insets, navigation drawer focus, Back, and reload. Main pages must not require horizontal page scrolling.
2. Test direct touch and trackpad modes, right click, drag, scroll, local zoom/pan, and fullscreen entry/exit. Release input when gestures cancel or orientation changes.
3. Submit text using software keyboards, composition, emoji, and non-Latin text. Text submission must be explicit and preserve composed text.
4. Search retained history and custom dates; load continuation pages and change query/device/monitor while requests are delayed. Old responses cannot replace the new context.
5. Navigate more than 3,000 frames and a tied-timestamp result set. Check exact capture links, monitor restoration, Back/Forward, and relevance/newest ordering.
6. Test DST gaps and repeated times, missing image files, and retention-expired bookmarks. Notes survive missing recordings; playback gaps do not imply continuous recording coverage.
7. Expand grouped similar hits and select each distinct result. Saved searches restore scope, dates, order, and monitor. Browser-local items remain scoped to server, user, and device.

## Performance, operations, and recovery

These remain future milestones. Measure actual constrained-network mobile load time, long-session memory, bounded frame queues, fleet request counts, database query plans, capture latency, and storage usage. Test retention cleanup against database rows and blobs, report retryable failures, and perform a backup restore into an isolated environment before claiming recovery works.
