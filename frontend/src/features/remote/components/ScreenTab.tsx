import { useCallback, useEffect, useRef, useState } from "react";
import { onSessionExpired } from "@/api/sessionExpiry";
import type { AgentInfo, DashboardRole } from "@/api/types";
import { useWsEvent } from "@/app/providers/useWsEvent";
import { StreamStatus } from "@/components/common/StatusIndicator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { capabilityAvailable, capabilityFullySupported, capabilityStatus } from "@/features/agent-detail/lib/agentCapabilities";
import { useDesktopAudio } from "@/features/remote/hooks/useDesktopAudio";
import { useFullscreen } from "@/features/remote/hooks/useFullscreen";
import type { DisplayedRemoteFrame } from "@/features/remote/hooks/useMjpegFrames";
import { useRemoteControlLease } from "@/features/remote/hooks/useRemoteControlLease";
import { useRemoteInput } from "@/features/remote/hooks/useRemoteInput";
import { useScreenStream } from "@/features/remote/hooks/useScreenStream";
import type { StreamPreset } from "@/features/remote/lib/streamPresets";
import { NotificationDialog } from "./NotificationDialog";
import type { RemoteKeyboardHandle } from "./RemoteSoftwareKeyboard";
import { ScreenViewport } from "./ScreenViewport";
import { StreamToolbar } from "./StreamToolbar";
import { StreamToolsSheet } from "./StreamToolsSheet";
import "./screen-remote.css";

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

/**
 * Live view and remote control of an agent's desktop. Composes the stream (useScreenStream with
 * the injected frame source), the control lease, remote input, desktop audio and fullscreen,
 * and lays out the viewport, toolbar, tools sheet and notification dialog.
 */
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
  const { source, frames, streaming, stalled: isStalled, monitorIndex } = stream;
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
    layout: { fullscreen, pseudoFs, aspectRatio: stream.aspectRatio },
  });
  const { ctrl, releaseHeldInput, setInputError, setZoom, setPan, touchAction } = input;
  const pointerEnabled = inputEnabled && frames.verified;
  const audio = useDesktopAudio({ agentId, online, enabled: source.audio });

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
  const reconnectStream = () => { abortStream(); releaseLease(); stream.restart(); };

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
  useEffect(() => {
    if (!streamActive || !online) { setToolsOpen(false); setClipboardOpen(false); setKeyboardOpen(false); setShowNotificationModal(false); }
  }, [streamActive, online]);

  const sendNotification = (title: string, message: string) => {
    if (!input.enabledNow()) return false;
    ctrl({ type: "Notify", title, message });
    return true;
  };

  const closeTools = () => { setToolsOpen(false); setClipboardOpen(false); };
  const connectionNote = blockedByRole ? "Sign-in access required." : !online ? "Agent offline." : !screenAvailable ? "Live desktop unavailable." : !streamEnabled ? "Live view paused." : frames.failed ? "Live view disconnected. Reconnect in More tools." : frames.connecting ? "Connecting to live view…" : isStalled ? "Live view stalled. Reconnect in More tools." : !canOperate ? "View only. Operator access needed." : !verifiedFrame ? "View only. Display not verified." : !remoteInputAvailable ? "View only. Authorize remote input on the device." : "";
  const errorText = input.inputError || lease.error;

  // Monitor picker (only shown when the agent reports more than one monitor).
  const monitors = agentInfo?.monitors ?? [];
  const primaryMonitorIndex = Math.max(0, monitors.findIndex((m) => m.primary));

  const remoteTools = <>
    <StreamToolbar
      control={{ active: inputEnabled, acquiring: lease.acquiring, allowed: remoteControlAllowed, onToggle: () => { if (!inputEnabled) { setInputError(""); lease.acquire(); } else lease.release(); } }}
      keyboard={{ open: keyboardOpen, enabled: inputEnabled, ref: keyboardRef, onToggle: () => { releaseHeldInput(); setKeyboardOpen(open => !open); }, onText: input.sendText }}
      tools={{ open: toolsOpen, triggerRef: toolsTrigger, onOpen: () => { releaseHeldInput(); setKeyboardOpen(false); setToolsOpen(true); } }}
      maximize={{ maximized: fullscreen || pseudoFs, disabled: !streamEnabled, onToggle: () => toggleMaximized(releaseHeldInput) }}
      error={errorText}
      note={connectionNote}
    />
    {toolsOpen && <StreamToolsSheet
      triggerRef={toolsTrigger}
      onClose={closeTools}
      message={{ text: errorText || connectionNote, alert: Boolean(errorText) }}
      control={{ agentId, inputEnabled, pointerEnabled, leaseToken: lease.token }}
      touch={{
        mode: input.touchMode,
        action: touchAction,
        onMode: mode => { releaseHeldInput(); input.setTouchMode(mode); closeTools(); },
        onAction: action => { releaseHeldInput(); input.setTouchAction(action); closeTools(); },
      }}
      clipboard={{ open: clipboardOpen, supported: capabilityStatus(agentInfo, "clipboard")?.toLowerCase() === "supported", onToggle: () => setClipboardOpen(open => !open) }}
      onKey={key => ctrl({ type: "KeyPress", key })}
      view={{
        enabled: streamEnabled,
        zoom: input.zoom,
        onZoomIn: () => { releaseHeldInput(); setZoom(value => Math.min(4, value + .5)); },
        onZoomOut: () => { releaseHeldInput(); setZoom(value => Math.max(1, value - .5)); setPan({ x: 0, y: 0 }); },
        onFit: () => { releaseHeldInput(); setZoom(1); setPan({ x: 0, y: 0 }); },
      }}
      stream={{
        disabled: !streamEnabled || blockedByRole,
        preset: stream.preset,
        onPreset: preset => { applyStreamPreset(preset); closeTools(); },
        monitors: streamEnabled && monitors.length > 1 ? monitors : null,
        selectedMonitor: monitorIndex ?? primaryMonitorIndex,
        onMonitor: index => { applyMonitor(index); closeTools(); },
        onReconnect: (frames.failed || isStalled) && online && streamEnabled && !blockedByRole ? () => { reconnectStream(); closeTools(); } : null,
      }}
      audio={{
        show: audioAvailable && canOperate,
        disabled: !online || !source.audio,
        active: audio.active,
        onToggle: () => { if (audio.active) audio.stop(); else void audio.start(); },
        note: source.audioNote,
      }}
      onNotify={inputEnabled ? () => { releaseHeldInput(); closeTools(); setShowNotificationModal(true); } : null}
      activeApp={placeholderSub}
    />}
  </>;

  const viewport = (layout: "embedded" | "card") => (
    <ScreenViewport
      layout={layout}
      containerRef={containerRef}
      onFocusLeave={releaseHeldInput}
      frames={frames}
      streamEnabled={streamEnabled}
      frameVisible={layout === "embedded" ? streamEnabled && streaming && !stream.error : streaming && !stream.error}
      online={online}
      aspectRatio={stream.aspectRatio}
      fullscreen={fullscreen}
      pseudoFs={pseudoFs}
      transform={`translate(${input.pan.x}px, ${input.pan.y}px) scale(${input.zoom})`}
      placeholder={{
        title: online ? (!screenAvailable ? "Live desktop unavailable" : stream.error ? "Stream unavailable" : streamEnabled ? "Connecting…" : "Live view paused") : "Agent offline",
        detail: !screenAvailable ? `Screen capture ${capabilityStatus(agentInfo, "screen_capture") ?? "unsupported"}.` : undefined,
        window: placeholderTitle,
      }}
      input={{
        show: streamEnabled && (inputEnabled || touchAction === "pan"),
        overlayRef,
        handlers: input.overlayHandlers,
        label: inputEnabled ? pointerEnabled ? "Remote control — click, drag, scroll and type to control the remote machine" : "Remote keyboard and scroll — pointer input unavailable" : "Pan local screen view",
        showCursor: input.touchMode === "trackpad" && Boolean(input.cursorPreview),
        cursorRef: input.cursorMarkerRef,
      }}
    >
      {remoteTools}
      <NotificationDialog
        open={showNotificationModal}
        onOpenChange={setShowNotificationModal}
        containerRef={containerRef}
        canSend={inputEnabled}
        onSend={sendNotification}
      />
    </ScreenViewport>
  );

  if (embedded) return viewport("embedded");

  return (
    <div className="vantyr-screen-tab">
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle>Screen</CardTitle>
          <StreamStatus state={blockedByRole ? "blocked" : streaming ? isStalled ? "stalled" : "streaming" : streamEnabled ? stream.error ? "stalled" : stream.everLoaded ? "waiting" : "starting" : "waiting"} />
        </CardHeader>
        <CardContent>{viewport("card")}</CardContent>
      </Card>
    </div>
  );
}
