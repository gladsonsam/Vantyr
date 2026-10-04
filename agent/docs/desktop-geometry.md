# Live desktop geometry contract (schema 1)

This stage changes live capture/input geometry only. Module permissions and their
`__module_generation` wire contract are unchanged. Live capture currently does
not resize: frame dimensions come from the actual captured RGB image. Recall's
separate thumbnail/downscale pipeline is unchanged.

## MonitorInfo JSON

`agent_info.monitors[]` retains `index`, `name`, `width`, `height`, `primary`.
Adds `x`, `y` (signed desktop origin), `physical_width`, `physical_height`
(unsigned desktop pixel dimensions), and `geometry_available` (boolean).
The four added numeric fields are null if physical geometry is unavailable.
Existing width/height keep their previous backend semantics; use the new physical
fields for desktop geometry, not a DPI multiplier. Index ordering is xcap's
current enumeration, not a persistent display identifier.

Windows extraction uses xcap's EnumDisplaySettingsW DEVMODE dmPosition/dmPels*
API. X11 extraction uses raw XCB RandR GetMonitors geometry, matching xcap's
output ID. xcap's Linux public width/x/y are DPI-divided, so those getters are
not used to infer physical pixels. Wayland/headless still report no monitor
picker list; no new compositor input or collection backend is introduced.

## Stream and control binding

Each live JPEG contains APP15 (FF EF), immediately after its SOI (FF D8).
The normal big-endian JPEG segment length includes its two length bytes.
Payload starts with `VantyrGeometry\0` (15 bytes, including NUL), then UTF-8 JSON:

```json
{"type":"capture_geometry","schema_version":1,"geometry":{"capture_id":"UUID","geometry_revision":1,"monitor_index":1,"desktop":{"x":-1080,"y":0,"physical_width":1080,"physical_height":1920},"frame_width":1080,"frame_height":1920}}
```

`desktop` is null when unavailable. Wayland reports monitor_index and desktop
null; it does not guess physical origin/DPI from compositor logical coordinates.
Ordinary JPEG decoders ignore the marker. Server forwarding must preserve it;
if the server re-encodes, it must explicitly preserve/relay this metadata.
Internal permission envelopes are still stripped before server transmission.
No additional WebSocket message or binary prefix is introduced.

Control commands can add `capture_id` and `geometry_revision` copied from the
frame being acted on. Supply both; malformed, partial, unknown or stale bindings
are rejected. Mouse x/y are **encoded frame pixel coordinates**, not CSS pixels
or global desktop coordinates. Coordinates are clamped to the image, then mapped
onto the selected physical desktop rectangle using rounded endpoint scaling:
`origin + round(clamped_pixel * (desktop_size - 1) / (frame_size - 1))`.
A one-pixel frame axis maps to its desktop origin. Windows absolute movement
uses SetPhysicalCursorPos, avoiding Enigo's primary-only absolute normalization;
X11 continues using Enigo absolute desktop movement. Other input semantics stay
unchanged. Stale geometry rejection invokes held-input release cleanup.

Capture and injection share a process-local mutex; injection holds it through
OS execution. Each capture start replaces the current UUID before scheduling
its worker. Superseded workers cannot publish geometry. Changes to selected
monitor/rectangle/frame dimensions, or an invalidated capture pass, advance the
revision. Old worker destruction cannot clear a replacement's selection.
Captured geometry is checked before and after the grab; observed layout changes
invalidate/drop that frame. Geometry is published with the encoded frame.

Without control bindings, legacy controls use the current selected mapping but
cannot fence delayed commands or old images. With no active stream, existing
absolute primary-compatible input remains available. When geometry is unavailable
for the default capture, unstamped legacy input retains its previous raw behavior;
this is explicitly unconfirmed mapping. Stamped mouse input requires physical
geometry. An invalid explicit X11/Windows monitor selection fails rather than
silently choosing primary. Explicit Wayland selection is unsupported.

## Limits

One capture selection exists per standalone agent or Windows capture-worker
process, not per viewer. A second viewer's start replaces the shared selection
and UUID; viewer-specific selection arbitration remains server/frontend work.
An unstamped old viewer may therefore act on the new selection. Buffered JPEGs
may arrive after a switch; stamped controls prevent acting on their old geometry.

Windows service/companion IPC forwards commands and JPEGs unchanged; the SYSTEM
capture worker owns both capture geometry and actual input mapping. The
companion's monitor enumeration may differ from the secure desktop; the frame
marker is the authority. Secure-desktop changes are detected at the existing
400 ms capture polling interval, then invalidate geometry; OS transitions and
input desktop attachment remain best effort. No atomic OS capture/injection
transaction, hotplug guarantee, Wayland physical mapping, or hardware verification
is claimed. Existing same-identity permission-store/admin-execution limitations
remain unchanged.
