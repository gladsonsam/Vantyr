import type { DisplayedRemoteFrame } from "@/features/remote/hooks/useMjpegFrames";
import { useScreenStream } from "@/features/remote/hooks/useScreenStream";
import { useDesktopAudio } from "@/features/remote/hooks/useDesktopAudio";
import { useFullscreen } from "@/features/remote/hooks/useFullscreen";
import { useRemoteControlLease } from "@/features/remote/hooks/useRemoteControlLease";
import { useRemoteInput } from "@/features/remote/hooks/useRemoteInput";
import "./screen-remote.css";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogTitle,
} from "@/components/ui/dialog";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Monitor, Maximize2, Minimize2, MousePointer2, Volume2, VolumeX, Keyboard, MoreHorizontal } from "lucide-react";
import { useCallback, useState, useRef, useEffect } from "react";
import { StreamStatus } from "@/components/common/StatusIndicator";
import type { AgentInfo, DashboardRole } from "@/api/types";
import { capabilityAvailable, capabilityFullySupported, capabilityStatus } from "@/features/agent-detail/lib/agentCapabilities";
import { RemoteToolsSheet, RemoteToolGroup } from "./RemoteToolsSheet";
import { RemoteClipboardPanel } from "./RemoteClipboardPanel";
import { RemoteSoftwareKeyboard, type RemoteKeyboardHandle } from "./RemoteSoftwareKeyboard";
import type { TouchMode, TouchAction } from "@/features/remote/lib/remoteTouch";
import { onSessionExpired } from "@/api/sessionExpiry";
import { useWsEvent } from "@/app/providers/useWsEvent";
import { STREAM_PRESET_OPTIONS, monitorLabel, type StreamPreset } from "@/features/remote/lib/streamPresets";

interface ScreenTabProps {
  agentId: string;
  sendWsMessage: (msg: unknown) => void;
  dashboardRole?: DashboardRole | null;
  /** When false, the MJPEG request is not started (tab hidden / navigated away). */
  streamActive?: boolean;
  /** Compact, chrome-light panel for the combined agent view (reference LiveScreen look). */
  embedded?: boolean;
  /** Drives the LIVE/OFFLINE badge + placeholder when embedded. */
  online?: boolean;
  /** Placeholder lines shown before the first frame (embedded mode). */
  placeholderTitle?: string;
  placeholderSub?: string;
  agentInfo?: AgentInfo | null;
}

export function ScreenTab({
  agentId,
  sendWsMessage,
  dashboardRole = null,
  streamActive = true,
  embedded = false,
  online = true,
  placeholderTitle,
  placeholderSub,
  agentInfo,
}: ScreenTabProps) {
  const [showNotificationModal, setShowNotificationModal] = useState(false);
  const [notificationTitle, setNotificationTitle] = useState("");
  const [notificationMessage, setNotificationMessage] = useState("");
  const beforeDisplayRef = useRef<(frame: DisplayedRemoteFrame | null) => void>(() => {});
  const onBeforeDisplay = useCallback((frame: DisplayedRemoteFrame | null) => beforeDisplayRef.current(frame), []);
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const keyboardRef = useRef<RemoteKeyboardHandle>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsTrigger = useRef<HTMLButtonElement>(null);
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  const canOperate = dashboardRole === "operator" || dashboardRole === "admin";
  // Viewers may watch; control, keyboard and desktop audio stay operator-only.
  const blockedByRole = !canOperate && dashboardRole !== "viewer";
  const screenAvailable = capabilityAvailable(agentInfo, "screen_capture");
  const audioAvailable = capabilityAvailable(agentInfo, "audio_capture");
  const remoteInputAvailable = capabilityFullySupported(agentInfo, "remote_input") && capabilityStatus(agentInfo, "remote_input")?.toLowerCase() === "supported";
  const streamEnabled = streamActive && screenAvailable;
  const stream = useScreenStream({ agentId, streamEnabled, online, blockedByRole, onBeforeDisplay });
  const { source, frames, streaming, everLoaded: streamEverLoaded, error: streamError, aspectRatio: streamAspectRatio, stalled: isStalled, monitorIndex } = stream;
  const { fullscreen, pseudoFs, toggle: toggleMaximized } = useFullscreen(containerRef, streamEnabled);
  const verifiedFrame = frames.verified;
  const remoteControlAllowed = online && streamEnabled && canOperate && remoteInputAvailable && verifiedFrame && !isStalled;
  const lease = useRemoteControlLease(agentId, remoteControlAllowed, sendWsMessage, { captureSession: stream.session || null, getCaptureStamp: frames.leaseStamp });
  const inputEnabled = remoteControlAllowed && lease.token !== null;
  const releaseLease = lease.release;
  const input = useRemoteInput({
    agentId,
    sendWsMessage,
    leaseToken: lease.token,
    inputEnabled,
    frames,
    monitorIndex,
    overlayRef,
    containerRef,
    keyboardRef,
    beforeDisplayRef,
    layout: { fullscreen, pseudoFs, aspectRatio: streamAspectRatio },
  });
  const { ctrl, sendText, releaseHeldInput, touchMode, setTouchMode, touchAction, setTouchAction, inputError, setInputError, zoom, setZoom, pan, setPan, cursorPreview } = input;
  const pointerEnabled = inputEnabled && frames.verified;
  const toggleFullscreen = () => toggleMaximized(releaseHeldInput);
  const reconnectStream = () => { stream.abort(); releaseLease(); stream.restart(); };

  const changeRemoteControl = (enabled: boolean) => {
    if (enabled) { setInputError(""); lease.acquire(); } else lease.release();
  };

  const { active: audioActive, start: startAudio, stop: stopAudio } = useDesktopAudio({ agentId, online, enabled: source.audio });

  // The source shows a live desktop by itself (the demo's fake desktop).
  const selfLive = frames.selfLive;

  // Monitor picker (only shown when the agent reports more than one monitor).
  const monitors = agentInfo?.monitors ?? [];
  const showMonitorPicker = streamEnabled && monitors.length > 1;
  const primaryMonitorIndex = Math.max(0, monitors.findIndex((m) => m.primary));
  const selectedMonitorIndex = monitorIndex ?? primaryMonitorIndex;

  const { abort: abortStream, changePreset, changeMonitor } = stream;
  const applyStreamPreset = useCallback(
    (next: StreamPreset) => {
      abortStream();
      releaseLease();
      changePreset(next);
    },
    [abortStream, releaseLease, changePreset],
  );

  const applyMonitor = useCallback(
    (next: number) => {
      abortStream();
      releaseLease();
      changeMonitor(next);
    },
    [abortStream, releaseLease, changeMonitor],
  );

  const { disable: disableInput } = input;
  useWsEvent("command_rejected", (message) => {
    if (message.agent_id !== agentId || message.module !== "remote_input") return;
    disableInput();
    releaseLease();
    setInputError(typeof message.error === "string" ? message.error : "Remote input rejected. Check module permissions.");
  });

  useEffect(() => {
    const expire = () => { disableInput(); releaseLease(); setClipboardOpen(false); };
    const storage = (event: StorageEvent) => { if (event.key === null || event.key === "vantyr-server-settings") expire(); };
    const unsubscribeExpiry = onSessionExpired(expire); window.addEventListener("storage", storage);
    return () => { unsubscribeExpiry(); window.removeEventListener("storage", storage); };
  }, [disableInput, releaseLease]);

  useEffect(() => {
    setClipboardOpen(false); setToolsOpen(false);
  }, [agentId, monitorIndex]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => containerRef.current?.style.setProperty("--remote-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
    update(); viewport?.addEventListener("resize", update); window.addEventListener("resize", update);
    return () => { viewport?.removeEventListener("resize", update); window.removeEventListener("resize", update); };
  }, []);

  const handleSendNotification = () => {
    if (!notificationTitle.trim()) return;

    if (!input.enabledNow()) return;
    ctrl({ type: "Notify", title: notificationTitle, message: notificationMessage });

    setShowNotificationModal(false);
    setNotificationTitle("");
    setNotificationMessage("");
  };

  useEffect(() => {
    if (!streamActive || !online) { setToolsOpen(false); setClipboardOpen(false); setKeyboardOpen(false); setShowNotificationModal(false); }
  }, [streamActive, online]);

  const closeTools = () => { setToolsOpen(false); setClipboardOpen(false); };
  const connectionNote = blockedByRole ? "Sign-in access required." : !online ? "Agent offline." : !screenAvailable ? "Live desktop unavailable." : !streamEnabled ? "Live view paused." : frames.failed ? "Live view disconnected. Reconnect in More tools." : frames.connecting ? "Connecting to live view…" : isStalled ? "Live view stalled. Reconnect in More tools." : !canOperate ? "View only. Operator access needed." : !verifiedFrame ? "View only. Display not verified." : !remoteInputAvailable ? "View only. Authorize remote input on the device." : "";
  const remoteTools = <>
    <div className="screen-remote-tools" aria-label="Remote input tools">
      <div className="remote-primary-actions">
        <button type="button" data-short-label={inputEnabled ? "Release" : lease.acquiring ? "Wait…" : "Control"} className={`remote-control-button${inputEnabled ? " is-controlling" : ""}`} aria-label={inputEnabled ? "Release control" : lease.acquiring ? "Requesting control" : "Take control"} title={inputEnabled ? "Release control" : lease.acquiring ? "Requesting control" : "Take control"} disabled={!remoteControlAllowed || lease.acquiring} onClick={() => changeRemoteControl(!inputEnabled)}>
          <MousePointer2 size={17} aria-hidden="true" /><span>{inputEnabled ? "Release control" : lease.acquiring ? "Requesting…" : "Take control"}</span>
        </button>
        <button type="button" data-short-label="Keyboard" aria-label="Software keyboard" title="Software keyboard" disabled={!inputEnabled} aria-expanded={keyboardOpen} className={keyboardOpen ? "is-active" : ""} onClick={() => { releaseHeldInput(); setKeyboardOpen(open => !open); }}><Keyboard size={18} aria-hidden="true" /><span>Keyboard</span></button>
        <button ref={toolsTrigger} type="button" data-short-label="Tools" aria-label="More tools" title="More tools" aria-haspopup="dialog" aria-expanded={toolsOpen} onClick={() => { releaseHeldInput(); setKeyboardOpen(false); setToolsOpen(true); }}><MoreHorizontal size={19} aria-hidden="true" /><span>More tools</span></button>
        <button type="button" data-short-label={fullscreen || pseudoFs ? "Exit" : "Expand"} aria-label={fullscreen || pseudoFs ? "Exit fullscreen" : "Maximize view"} title={fullscreen || pseudoFs ? "Exit fullscreen" : "Maximize view"} disabled={!streamEnabled} onClick={toggleFullscreen}>{fullscreen || pseudoFs ? <Minimize2 size={18} aria-hidden="true" /> : <Maximize2 size={18} aria-hidden="true" />}<span className="remote-fullscreen-label">{fullscreen || pseudoFs ? "Exit fullscreen" : "Fullscreen"}</span></button>
      </div>
      {(inputError || lease.error) ? <span className="remote-connection-note" role="alert">{inputError || lease.error}</span> : connectionNote ? <span className="remote-connection-note" role="status">{connectionNote}</span> : null}
      {keyboardOpen && <div className="remote-keyboard-tray"><RemoteSoftwareKeyboard ref={keyboardRef} enabled={inputEnabled} onText={sendText} /></div>}
    </div>
    {toolsOpen && <RemoteToolsSheet triggerRef={toolsTrigger} onClose={closeTools}>
      {(inputError || lease.error || connectionNote) && <p className="remote-tool-hint" role={inputError || lease.error ? "alert" : "status"}>{inputError || lease.error || connectionNote}</p>}
      <RemoteToolGroup title="Pointer & gestures">
        <div className="remote-tool-fields">
          <label>Touch mode <select aria-label="Touch mode" value={touchMode} onChange={event => { releaseHeldInput(); setTouchMode(event.target.value as TouchMode); closeTools(); }}><option value="direct">Direct touch</option><option value="trackpad">Trackpad</option></select></label>
          <label>Touch action <select aria-label="Touch action" value={touchAction} onChange={event => { releaseHeldInput(); setTouchAction(event.target.value as TouchAction); closeTools(); }}>
            <option value="tap" disabled={!pointerEnabled}>Tap / move pointer</option><option value="right" disabled={!pointerEnabled}>Right click</option><option value="drag" disabled={!pointerEnabled}>Drag</option><option value="scroll" disabled={!inputEnabled}>Scroll</option><option value="pan">Pan local view</option>
          </select></label>
        </div>
        <p className="remote-tool-hint">Trackpad: swipe moves, tap clicks.</p>
      </RemoteToolGroup>
      <section className="remote-tool-group">
        <button type="button" className="remote-tool-group-toggle" aria-expanded={clipboardOpen} onClick={() => setClipboardOpen(open => !open)}>Text clipboard<span aria-hidden="true">{clipboardOpen ? "−" : "+"}</span></button>
        {clipboardOpen && <div className="remote-tool-group-content">{inputEnabled && lease.token ? <RemoteClipboardPanel key={`${agentId}:${lease.token}`} agentId={agentId} controlToken={lease.token} supported={capabilityStatus(agentInfo, "clipboard")?.toLowerCase() === "supported"} /> : <p role="status">Take control to use the clipboard.</p>}</div>}
      </section>
      <RemoteToolGroup title="Remote keys">
        <div className="remote-shortcuts">{[ ["Tab", "tab"], ["Esc", "escape"], ["Enter", "enter"], ["←", "arrowleft"], ["↑", "arrowup"], ["↓", "arrowdown"], ["→", "arrowright"] ].map(([label, key]) => <button key={key} type="button" disabled={!inputEnabled} aria-label={`Remote ${key}`} onClick={() => ctrl({ type: "KeyPress", key })}>{label}</button>)}</div>
      </RemoteToolGroup>
      <RemoteToolGroup title="View & stream">
        <div className="remote-tool-buttons">
          <button type="button" aria-label="Zoom in locally" disabled={!streamEnabled || zoom >= 4} onClick={() => { releaseHeldInput(); setZoom(value => Math.min(4, value + .5)); }}>Zoom +</button>
          <button type="button" aria-label="Zoom out locally" disabled={!streamEnabled || zoom <= 1} onClick={() => { releaseHeldInput(); setZoom(value => Math.max(1, value - .5)); setPan({ x: 0, y: 0 }); }}>Zoom −</button>
          <button type="button" onClick={() => { releaseHeldInput(); setZoom(1); setPan({ x: 0, y: 0 }); }}>Fit view ({zoom}×)</button>
        </div>
        <div className="remote-tool-fields">
          <label>Stream quality <select aria-label="Stream quality" disabled={!streamEnabled || blockedByRole} value={stream.preset} onChange={event => { applyStreamPreset(event.target.value as StreamPreset); closeTools(); }}>{STREAM_PRESET_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          {showMonitorPicker && <label>Monitor <select aria-label="Monitor" disabled={!streamEnabled || blockedByRole} value={selectedMonitorIndex} onChange={event => { applyMonitor(Number(event.target.value)); closeTools(); }}>{monitors.map((monitor, index) => <option key={index} value={index}>{monitorLabel(monitor, index)}</option>)}</select></label>}
        </div>
        {(frames.failed || isStalled) && online && streamEnabled && !blockedByRole && <button type="button" onClick={() => { reconnectStream(); closeTools(); }}>Reconnect live view</button>}
      </RemoteToolGroup>
      <RemoteToolGroup title="Audio & notification">
        <div className="remote-tool-buttons">
          {audioAvailable && canOperate && <button type="button" disabled={!online || !source.audio} aria-pressed={audioActive} onClick={() => { if (audioActive) stopAudio(); else void startAudio(); }}>{audioActive ? <Volume2 size={17} aria-hidden="true" /> : <VolumeX size={17} aria-hidden="true" />}{audioActive ? "Mute desktop audio" : "Hear desktop audio"}</button>}
          <button type="button" disabled={!inputEnabled} onClick={() => { releaseHeldInput(); closeTools(); setShowNotificationModal(true); }}>Send notification</button>
        </div>
        {source.audioNote && <p className="remote-tool-hint">{source.audioNote}</p>}
      </RemoteToolGroup>
      <RemoteToolGroup title="Help">
        <p className="remote-tool-hint">Pan and zoom only change your view.</p>
        <p className="remote-tool-hint">Control ends on focus loss or a display change. Ctrl+Alt+Del is unavailable.</p>
        {placeholderSub && <p className="remote-tool-hint">Active app: {placeholderSub}</p>}
      </RemoteToolGroup>
    </RemoteToolsSheet>}
  </>;

  const notificationModal = (
    <Dialog open={showNotificationModal} onOpenChange={setShowNotificationModal}>
      {/* Custom container (not document.body): the dialog must stay inside the
          viewer's fullscreen tree so it remains visible while maximized. */}
      <DialogPrimitive.Portal container={containerRef}>
        <DialogOverlay />
        <DialogPrimitive.Popup
          data-slot="dialog-content"
          className={cn(
            "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm",
          )}
        >
          <DialogHeader>
            <DialogTitle>Send notification</DialogTitle>
          </DialogHeader>
          <DialogPrimitive.Close
            data-slot="dialog-close"
            aria-label="Close"
            render={<Button variant="ghost" className="absolute top-2 right-2" size="icon-sm" />}
          >
            <XIcon />
          </DialogPrimitive.Close>
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="remote-notification-title">Title</FieldLabel>
            <Input
              id="remote-notification-title"
              aria-label="Notification title"
              maxLength={64}
              value={notificationTitle}
              onChange={(e) => setNotificationTitle(e.target.value)}
              placeholder="Notification title"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="remote-notification-message">Message</FieldLabel>
            <Input
              id="remote-notification-message"
              aria-label="Notification message"
              maxLength={256}
              value={notificationMessage}
              onChange={(e) => setNotificationMessage(e.target.value)}
              placeholder="Optional message"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowNotificationModal(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSendNotification}
            disabled={!inputEnabled || !notificationTitle.trim()}
          >
            Send
          </Button>
        </DialogFooter>
      </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </Dialog>
  );

  if (embedded) {
    const showFrame = streamEnabled && streaming && !streamError;
    const isMaximized = fullscreen || pseudoFs;
    return (
      <div
        ref={containerRef}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) releaseHeldInput(); }}
        className={`screen-remote-panel flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-card${fullscreen || pseudoFs ? " screen-remote-maximized" : ""}${isMaximized ? " bg-black!" : ""}`}
        style={{
          flex: "1 1 0",
          ...(isMaximized
            ? { borderRadius: 0 }
            : {}),
          ...(pseudoFs
            ? {
                position: "fixed",
                inset: 0,
                zIndex: 3000,
                width: "100vw",
                height: "100vh",
              }
            : {}),
        }}
      >
        <div className="screen-remote-stage" style={{ position: "relative", width: "100%", ...(isMaximized ? { flex: 1, minHeight: 0 } : streamEnabled || selfLive ? { aspectRatio: streamAspectRatio ?? "16 / 9", maxHeight: "min(58vh, 600px)" } : { height: 160 }), background: "#0a0b0d", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1.4px)", backgroundSize: "22px 22px" }} />
          {frames.render({ layout: "embedded", streamEnabled, visible: showFrame, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` })}

          {/* LIVE / OFFLINE badge */}
          <div className="absolute top-3.5 left-3.5 flex items-center gap-[7px] rounded-lg border border-white/10 bg-black/50 px-2.5 py-[5px]">
            <span className={`size-[7px] rounded-full ${online ? "bg-destructive" : "bg-muted-foreground"}`} />
            <span className={`text-[11px] font-bold tracking-[0.08em] ${online ? "text-white" : "text-muted-foreground"}`}>{online ? "LIVE" : "OFFLINE"}</span>
          </div>
          <div className="absolute top-3.5 right-3.5 font-mono text-[11px] text-muted-foreground">
            {showFrame || selfLive ? "MJPEG · live" : online ? "connecting…" : "—"}
          </div>

          {!showFrame && !selfLive && (
            <div className="relative p-4 text-center">
              <div className={`mx-auto mb-3.5 flex size-15 items-center justify-center rounded-2xl bg-muted/70 ${online ? "text-success" : "text-muted-foreground"}`}>
                <Monitor size={28} />
              </div>
              <div className="text-sm font-semibold text-muted-foreground">
                {online ? (!screenAvailable ? "Live desktop unavailable" : streamError ? "Stream unavailable" : streamEnabled ? "Connecting…" : "Live view paused") : "Agent offline"}
              </div>
              {!screenAvailable && (
                <div className="mt-1 text-xs text-muted-foreground">
                  Screen capture {capabilityStatus(agentInfo, "screen_capture") ?? "unsupported"}.
                </div>
              )}
              {placeholderTitle && (
                <div className="mt-1 font-mono text-xs text-muted-foreground">{placeholderTitle}</div>
              )}
            </div>
          )}

          {streamEnabled && (inputEnabled || touchAction === "pan") && (
            <div
              ref={overlayRef}
              className="vantyr-remote-overlay"
              {...input.overlayHandlers}
              tabIndex={0}
              role="application"
              aria-label={inputEnabled ? pointerEnabled ? "Remote control — click, drag, scroll and type to control the remote machine" : "Remote keyboard and scroll — pointer input unavailable" : "Pan local screen view"}
            >{touchMode === "trackpad" && cursorPreview && <span ref={input.cursorMarkerRef} className="remote-trackpad-cursor" aria-hidden="true" />}</div>
          )}
        </div>

        {remoteTools}
        {notificationModal}
      </div>
    );
  }

  return (
    <div className="vantyr-screen-tab">
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle>Screen</CardTitle>
          <StreamStatus state={blockedByRole ? "blocked" : streaming ? isStalled ? "stalled" : "streaming" : streamEnabled ? streamError ? "stalled" : streamEverLoaded ? "waiting" : "starting" : "waiting"} />
        </CardHeader>
        <CardContent>
          <div
          ref={containerRef}
          onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) releaseHeldInput(); }}
          className={`screen-remote-panel vantyr-screen-viewer${fullscreen ? " vantyr-screen-viewer-fullscreen screen-remote-maximized" : ""}${pseudoFs ? " screen-remote-maximized" : ""}`}
          style={{ position: "relative", ...(pseudoFs ? { position: "fixed", inset: 0, zIndex: 3000, display: "flex", flexDirection: "column", width: "100vw" } as const : {}) }}
        >
          <div className="vantyr-screen-frame screen-remote-stage">
            {frames.render({ layout: "card", streamEnabled, visible: streaming && !streamError, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` })}
            {streamEnabled && (inputEnabled || touchAction === "pan") && (
              <div
                ref={overlayRef}
                className="vantyr-remote-overlay"
                {...input.overlayHandlers}
                tabIndex={0}
                role="application"
                aria-label={inputEnabled ? pointerEnabled ? "Remote control — click, drag, scroll and type to control the remote machine" : "Remote keyboard and scroll — pointer input unavailable" : "Pan local screen view"}
              >{touchMode === "trackpad" && cursorPreview && <span ref={input.cursorMarkerRef} className="remote-trackpad-cursor" aria-hidden="true" />}</div>
            )}
          </div>
          {remoteTools}
          {notificationModal}
        </div>
        </CardContent>
      </Card>
    </div>
  );
}
