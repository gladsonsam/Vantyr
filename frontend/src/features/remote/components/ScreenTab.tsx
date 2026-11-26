import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from "react";
import { onSessionExpired } from "@/api/sessionExpiry";
import type { AgentInfo, DashboardRole } from "@/api/types";
import { useWsEvent } from "@/app/providers/useWsEvent";
import { StreamStatus } from "@/components/common/StatusIndicator";
import { Card, CardContent, CardHeader, CardTitle } from "@vantyr/ui/components/card";
import {
  capabilityAvailable,
  capabilityFullySupported,
  capabilityStatus,
} from "@/features/agent-detail/lib/agentCapabilities";
import { useDeviceModuleGrants } from "@/features/agent-settings/useDeviceModuleGrants";
import { useDesktopAudio } from "@/features/remote/hooks/useDesktopAudio";
import { useFullscreen } from "@/features/remote/hooks/useFullscreen";
import { useImmersiveChrome } from "@/features/remote/hooks/useImmersiveChrome";
import type { DisplayedRemoteFrame } from "@/features/remote/hooks/useMjpegFrames";
import { useRemoteControlLease } from "@/features/remote/hooks/useRemoteControlLease";
import { useRemoteKeyboardCapture } from "@/features/remote/hooks/useKeyboardLock";
import { useRemoteInput } from "@/features/remote/hooks/useRemoteInput";
import { useScreenStream } from "@/features/remote/hooks/useScreenStream";
import {
  useFullscreenControlPreference,
  useSoundPreference,
} from "@/features/remote/hooks/useSoundPreference";
import type { StreamPreset } from "@/features/remote/lib/streamPresets";
import { NotificationDialog } from "./NotificationDialog";
import type { RemoteKeyboardHandle } from "./RemoteSoftwareKeyboard";
import { ScreenViewport } from "./ScreenViewport";
import { StreamToolbar } from "./StreamToolbar";
import { StreamToolsSheet } from "./StreamToolsSheet";
import "./screen-remote.css";

const LIVE_SCREEN_OFF =
  "Live screen is off on this device. Turn it on in the Vantyr app there (Settings → Modules).";

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
  const beforeDisplayRef = useRef<(frame: DisplayedRemoteFrame | null) => void>(() => {});
  const onBeforeDisplay = useCallback(
    (frame: DisplayedRemoteFrame | null) => beforeDisplayRef.current(frame),
    [],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const keyboardRef = useRef<RemoteKeyboardHandle>(null);
  const toolsTrigger = useRef<HTMLButtonElement>(null);
  const clipboardTrigger = useRef<HTMLButtonElement>(null);

  const canOperate = isOperator(dashboardRole);
  // Viewers may watch; control, keyboard and desktop audio stay operator-only.
  const blockedByRole = !canOperate && dashboardRole !== "viewer";
  const screenAvailable = capabilityAvailable(agentInfo, "screen_capture");
  const audioAvailable = capabilityAvailable(agentInfo, "audio_capture");
  const grants = useDeviceModuleGrants(agentId, canOperate && online);
  // The server refuses a stream the device hasn't granted, so don't start one that can only fail.
  const liveScreenOff = grants.granted("live_screen") === false;
  const remoteInputAvailable = remoteInputAllowed(agentInfo, grants.granted("remote_input"));
  const streamEnabled = streamActive && screenAvailable && !liveScreenOff;

  const stream = useScreenStream({
    agentId,
    streamEnabled,
    online,
    blockedByRole,
    onBeforeDisplay,
    videoEnabled: capabilityStatus(agentInfo, "screen_h264") === "supported",
  });
  const { source, frames, streaming, stalled: isStalled, monitorIndex } = stream;
  const {
    showNotificationModal,
    setShowNotificationModal,
    toolsOpen,
    setToolsOpen,
    clipboardTriggerUsed,
    setClipboardTriggerUsed,
    clipboardOpen,
    setClipboardOpen,
    keyboardOpen,
    setKeyboardOpen,
  } = useRemotePanels(
    `${agentId}:${monitorIndex}`,
    `${streamActive}:${online}`,
    streamActive && online,
  );
  const {
    fullscreen,
    pseudoFs,
    toggle: toggleMaximized,
  } = useFullscreen(containerRef, streamEnabled);
  const verifiedFrame = frames.verified;
  const remoteControlAllowed = [
    online,
    streamEnabled,
    canOperate,
    remoteInputAvailable,
    verifiedFrame,
    !isStalled,
  ].every(Boolean);
  const lease = useRemoteControlLease(agentId, remoteControlAllowed, sendWsMessage, {
    captureSession: stream.session || null,
    getCaptureStamp: frames.leaseStamp,
  });
  const inputEnabled = remoteControlAllowed && lease.token !== null;
  const releaseLease = lease.release;
  const keyboardCapture = useRemoteKeyboardCapture({
    controlling: inputEnabled,
    canControl: remoteControlAllowed,
    nativeFullscreen: fullscreen,
    pseudoFs,
  });
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
    onScreenGesture: keyboardCapture.retry,
  });
  const { ctrl, releaseHeldInput, setInputError, touchAction } = input;
  const pointerEnabled = inputEnabled && frames.verified;
  const audio = useDesktopAudio({
    agentId,
    online,
    enabled: [source.audio, canOperate, audioAvailable, streamActive].every(Boolean),
  });
  const sound = useSoundPreference(
    audio,
    [source.audio, canOperate, audioAvailable, streamActive, online, verifiedFrame].every(Boolean),
  );
  const [fullscreenControl, setFullscreenControl] = useFullscreenControlPreference();

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
  const reconnectStream = () => {
    abortStream();
    releaseLease();
    stream.restart();
  };

  const { disable: disableInput } = input;
  useRemoteInputRejection(agentId, disableInput, releaseLease, setInputError);

  useEffect(() => {
    const expire = () => {
      disableInput();
      releaseLease();
      setClipboardOpen(false);
    };
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === "vantyr-server-settings") expire();
    };
    const unsubscribeExpiry = onSessionExpired(expire);
    window.addEventListener("storage", storage);
    return () => {
      unsubscribeExpiry();
      window.removeEventListener("storage", storage);
    };
  }, [disableInput, releaseLease, setClipboardOpen]);

  useViewportHeight(containerRef);

  const sendNotification = (title: string, message: string) => {
    if (!input.enabledNow()) return false;
    ctrl({ type: "Notify", title, message });
    return true;
  };

  const connectionNote = remoteConnectionNote({
    blockedByRole,
    online,
    screenAvailable,
    liveScreenOff,
    streamEnabled,
    frames,
    isStalled,
    canOperate,
    verifiedFrame,
    remoteInputAvailable,
  });
  const errorText = input.inputError || lease.error || audio.error;

  const canReconnect = [frames.failed || isStalled, online, streamEnabled, !blockedByRole].every(
    Boolean,
  );
  const remoteTools = (
    <ScreenTools
      agentId={agentId}
      agentInfo={agentInfo}
      stream={stream}
      lease={lease}
      input={input}
      audio={audio}
      sound={sound}
      fullscreenControl={{
        enabled: fullscreenControl,
        onChange: setFullscreenControl,
      }}
      inputEnabled={inputEnabled}
      pointerEnabled={pointerEnabled}
      remoteControlAllowed={remoteControlAllowed}
      audioAvailable={audioAvailable}
      canOperate={canOperate}
      online={online}
      blockedByRole={blockedByRole}
      streamEnabled={streamEnabled}
      maximized={fullscreen || pseudoFs}
      onMaximize={() => toggleMaximized(releaseHeldInput)}
      shortcutHint={keyboardCapture.hint}
      fullscreenTitle={keyboardCapture.fullscreenTitle}
      toolsTrigger={toolsTrigger}
      clipboardTrigger={clipboardTrigger}
      keyboardRef={keyboardRef}
      overlayRef={overlayRef}
      panels={{
        showNotificationModal,
        toolsOpen,
        keyboardOpen,
        clipboardOpen,
        clipboardTriggerUsed,
        setToolsOpen,
        setKeyboardOpen,
        setClipboardOpen,
        setClipboardTriggerUsed,
        setShowNotificationModal,
      }}
      canReconnect={canReconnect}
      connectionNote={connectionNote}
      errorText={errorText}
      placeholderSub={placeholderSub}
      applyStreamPreset={applyStreamPreset}
      applyMonitor={applyMonitor}
      reconnectStream={reconnectStream}
    />
  );

  const viewport = (layout: "embedded" | "card") => (
    <ScreenViewport
      layout={layout}
      containerRef={containerRef}
      onFocusLeave={releaseHeldInput}
      frames={frames}
      streamEnabled={streamEnabled}
      frameVisible={visibleRemoteFrame(layout, streamEnabled, streaming, stream.error)}
      online={online}
      aspectRatio={stream.aspectRatio}
      fullscreen={fullscreen}
      pseudoFs={pseudoFs}
      transform={`translate(${input.pan.x}px, ${input.pan.y}px) scale(${input.zoom})`}
      placeholder={remotePlaceholder({
        online,
        screenAvailable,
        liveScreenOff,
        streamError: stream.error,
        streamEnabled,
        screenStatus: capabilityStatus(agentInfo, "screen_capture"),
        placeholderTitle,
      })}
      input={{
        show: showInputOverlay(streamEnabled, inputEnabled, touchAction),
        overlayRef,
        handlers: input.overlayHandlers,
        label: remoteInputLabel(inputEnabled, pointerEnabled),
        showCursor: showTrackpadCursor(input.touchMode, input.cursorPreview),
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
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle>Screen</CardTitle>
          <StreamStatus
            state={remoteBadgeState({
              blockedByRole,
              streaming,
              isStalled,
              streamEnabled,
              streamError: stream.error,
              everLoaded: stream.everLoaded,
            })}
          />
        </CardHeader>
        <CardContent>{viewport("card")}</CardContent>
      </Card>
    </div>
  );
}

function remoteConnectionNote({
  blockedByRole,
  online,
  screenAvailable,
  liveScreenOff,
  streamEnabled,
  frames,
  isStalled,
  canOperate,
  verifiedFrame,
  remoteInputAvailable,
}: {
  blockedByRole: boolean;
  online: boolean;
  screenAvailable: boolean;
  liveScreenOff: boolean;
  streamEnabled: boolean;
  frames: { failed: boolean; failureReason?: string; connecting: boolean };
  isStalled: boolean;
  canOperate: boolean;
  verifiedFrame: boolean;
  remoteInputAvailable: boolean;
}): string {
  return blockedByRole
    ? "Sign-in access required."
    : !online
      ? "Agent offline."
      : !screenAvailable
        ? "Live desktop unavailable."
        : liveScreenOff
          ? LIVE_SCREEN_OFF
          : !streamEnabled
            ? "Live view paused."
            : frames.failed
              ? frames.failureReason
                ? `Live view stopped. ${frames.failureReason.replace(/\.?$/, ".")}`
                : "Live view disconnected. Use Reconnect to try again."
              : frames.connecting
                ? "Connecting to live view…"
                : isStalled
                  ? "Live view stalled. Use Reconnect to try again."
                  : !canOperate
                    ? "View only. Operator access needed."
                    : !verifiedFrame
                      ? "View only. Display not verified."
                      : !remoteInputAvailable
                        ? "View only. Authorize remote input on the device."
                        : "";
}

function isOperator(role: DashboardRole | null): boolean {
  return role === "operator" || role === "admin";
}
function remoteInputAllowed(
  info: AgentInfo | null | undefined,
  granted: boolean | null | undefined,
): boolean {
  return (
    capabilityFullySupported(info, "remote_input") &&
    capabilityStatus(info, "remote_input")?.toLowerCase() === "supported" &&
    granted !== false
  );
}
function toggleDesktopAudio(audio: {
  active: boolean;
  connecting: boolean;
  stop: () => void;
  start: () => Promise<void>;
}): void {
  if (audio.active || audio.connecting) audio.stop();
  else void audio.start();
}
function visibleRemoteFrame(
  layout: string,
  enabled: boolean,
  streaming: boolean,
  error: boolean,
): boolean {
  return layout === "embedded" ? enabled && streaming && !error : streaming && !error;
}
function remoteInputLabel(enabled: boolean, pointer: boolean): string {
  if (!enabled) return "Pan local screen view";
  return pointer
    ? "Remote control — click, drag, scroll and type to control the remote machine"
    : "Remote keyboard and scroll — pointer input unavailable";
}
function remotePlaceholder({
  online,
  screenAvailable,
  liveScreenOff,
  streamError,
  streamEnabled,
  screenStatus,
  placeholderTitle,
}: {
  online: boolean;
  screenAvailable: boolean;
  liveScreenOff: boolean;
  streamError: boolean;
  streamEnabled: boolean;
  screenStatus: string | null | undefined;
  placeholderTitle?: string;
}) {
  const title = online
    ? !screenAvailable
      ? "Live desktop unavailable"
      : liveScreenOff
        ? "Live screen is off on this device"
        : streamError
          ? "Stream unavailable"
          : streamEnabled
            ? "Connecting…"
            : "Live view paused"
    : "Agent offline";
  const detail = !screenAvailable
    ? `Screen capture ${screenStatus ?? "unsupported"}.`
    : liveScreenOff && online
      ? "Turn it on in the Vantyr app there (Settings → Modules)."
      : undefined;
  return { title, detail, window: placeholderTitle };
}
function remoteBadgeState({
  blockedByRole,
  streaming,
  isStalled,
  streamEnabled,
  streamError,
  everLoaded,
}: {
  blockedByRole: boolean;
  streaming: boolean;
  isStalled: boolean;
  streamEnabled: boolean;
  streamError: boolean;
  everLoaded: boolean;
}) {
  return blockedByRole
    ? "blocked"
    : streaming
      ? isStalled
        ? "stalled"
        : "streaming"
      : streamEnabled
        ? streamError
          ? "stalled"
          : everLoaded
            ? "waiting"
            : "starting"
        : "waiting";
}

interface ScreenToolsProps {
  agentId: string;
  agentInfo?: AgentInfo | null;
  stream: ReturnType<typeof useScreenStream>;
  lease: ReturnType<typeof useRemoteControlLease>;
  input: ReturnType<typeof useRemoteInput>;
  audio: ReturnType<typeof useDesktopAudio>;
  sound: ReturnType<typeof useSoundPreference>;
  /** "Fullscreen also takes control" setting. */
  fullscreenControl: { enabled: boolean; onChange: (enabled: boolean) => void };
  inputEnabled: boolean;
  pointerEnabled: boolean;
  remoteControlAllowed: boolean;
  audioAvailable: boolean;
  canOperate: boolean;
  online: boolean;
  blockedByRole: boolean;
  streamEnabled: boolean;
  maximized: boolean;
  onMaximize: () => void;
  shortcutHint: string;
  fullscreenTitle?: string;
  toolsTrigger: RefObject<HTMLButtonElement | null>;
  clipboardTrigger: RefObject<HTMLButtonElement | null>;
  keyboardRef: RefObject<RemoteKeyboardHandle | null>;
  /** The desktop input layer; Escape from the maximized toolbar returns focus here. */
  overlayRef: RefObject<HTMLDivElement | null>;
  panels: {
    showNotificationModal: boolean;
    toolsOpen: boolean;
    keyboardOpen: boolean;
    clipboardOpen: boolean;
    clipboardTriggerUsed: boolean;
    setToolsOpen: Dispatch<SetStateAction<boolean>>;
    setKeyboardOpen: Dispatch<SetStateAction<boolean>>;
    setClipboardOpen: Dispatch<SetStateAction<boolean>>;
    setClipboardTriggerUsed: Dispatch<SetStateAction<boolean>>;
    setShowNotificationModal: Dispatch<SetStateAction<boolean>>;
  };
  canReconnect: boolean;
  connectionNote: string;
  errorText: string;
  placeholderSub?: string;
  applyStreamPreset: (preset: StreamPreset) => void;
  applyMonitor: (index: number) => void;
  reconnectStream: () => void;
}
function ScreenTools({
  agentId,
  agentInfo,
  stream,
  lease,
  input,
  audio,
  sound,
  fullscreenControl,
  inputEnabled,
  pointerEnabled,
  remoteControlAllowed,
  audioAvailable,
  canOperate,
  online,
  blockedByRole,
  streamEnabled,
  maximized,
  onMaximize,
  shortcutHint,
  fullscreenTitle,
  toolsTrigger,
  clipboardTrigger,
  keyboardRef,
  overlayRef,
  panels,
  canReconnect,
  connectionNote,
  errorText,
  placeholderSub,
  applyStreamPreset,
  applyMonitor,
  reconnectStream,
}: ScreenToolsProps) {
  const {
    showNotificationModal,
    toolsOpen,
    keyboardOpen,
    clipboardOpen,
    clipboardTriggerUsed,
    setToolsOpen,
    setKeyboardOpen,
    setClipboardOpen,
    setClipboardTriggerUsed,
    setShowNotificationModal,
  } = panels;
  const immersive = useImmersiveChrome({
    active: maximized,
    held: toolsOpen || keyboardOpen || clipboardOpen || showNotificationModal,
    restoreFocus: () => {
      overlayRef.current?.focus();
      return Boolean(overlayRef.current) && document.activeElement === overlayRef.current;
    },
  });
  const { source, monitorIndex } = stream;
  const { ctrl, releaseHeldInput, setInputError, setZoom, setPan, touchAction } = input;
  const closeTools = () => {
    setToolsOpen(false);
    setClipboardOpen(false);
  };
  const toggleAudio = () => {
    // Remember the choice: stopping means "off" from now on, starting means "on".
    sound.setWanted(!(audio.active || audio.connecting));
    toggleDesktopAudio(audio);
  };
  const takeControl = () => {
    setInputError("");
    lease.acquire();
  };
  // One click: request fullscreen first (it needs the click's user activation), then ask for
  // control. If control isn't possible the view is still maximized and the reason is shown.
  const controlInFullscreen = () => {
    if (!maximized) onMaximize();
    if (inputEnabled) return;
    if (remoteControlAllowed) takeControl();
    else setInputError(connectionNote);
  };
  const maximizeToggle = () => {
    if (!maximized && fullscreenControl.enabled && !inputEnabled) controlInFullscreen();
    else onMaximize();
  };
  const monitorSelection = remoteMonitorSelection(agentInfo, streamEnabled, monitorIndex);
  const audioControls = remoteAudioControls(
    audio,
    source,
    canOperate,
    audioAvailable,
    online,
    sound.awaitingGesture,
  );
  return (
    <>
      <StreamToolbar
        hint={shortcutHint}
        control={{
          active: inputEnabled,
          acquiring: lease.acquiring,
          allowed: remoteControlAllowed,
          busy: /another viewer|owns remote control/i.test(lease.error),
          onToggle: () => {
            if (!inputEnabled) takeControl();
            else lease.release();
          },
          onFullscreen: controlInFullscreen,
          fullscreenActive: maximized,
        }}
        keyboard={{
          open: keyboardOpen,
          enabled: inputEnabled,
          ref: keyboardRef,
          onToggle: () => {
            releaseHeldInput();
            setKeyboardOpen((open) => !open);
          },
          onText: input.sendText,
        }}
        tools={{
          open: toolsOpen,
          triggerRef: toolsTrigger,
          onOpen: () => {
            releaseHeldInput();
            setKeyboardOpen(false);
            setClipboardTriggerUsed(false);
            setToolsOpen(true);
          },
        }}
        maximize={{
          maximized,
          disabled: !streamEnabled,
          onToggle: maximizeToggle,
          title: fullscreenTitle,
        }}
        clipboard={{
          ref: clipboardTrigger,
          open: toolsOpen && clipboardOpen,
          enabled: inputEnabled,
          onOpen: () => {
            releaseHeldInput();
            setKeyboardOpen(false);
            setClipboardOpen(true);
            setClipboardTriggerUsed(true);
            setToolsOpen(true);
          },
        }}
        audio={{
          ...audioControls,
          connecting: audio.connecting,
          onToggle: toggleAudio,
        }}
        onReconnect={canReconnect ? reconnectStream : null}
        error={errorText}
        note={connectionNote}
        immersive={maximized ? immersive : null}
      />
      {toolsOpen && (
        <StreamToolsSheet
          triggerRef={clipboardTriggerUsed ? clipboardTrigger : toolsTrigger}
          onClose={closeTools}
          message={{
            text: errorText || connectionNote,
            alert: Boolean(errorText),
          }}
          control={{
            agentId,
            inputEnabled,
            pointerEnabled,
            leaseToken: lease.token,
          }}
          touch={{
            mode: input.touchMode,
            action: touchAction,
            onMode: (mode) => {
              releaseHeldInput();
              input.setTouchMode(mode);
              closeTools();
            },
            onAction: (action) => {
              releaseHeldInput();
              input.setTouchAction(action);
              closeTools();
            },
          }}
          clipboard={{
            open: clipboardOpen,
            supported: capabilityStatus(agentInfo, "clipboard")?.toLowerCase() === "supported",
            onToggle: () => setClipboardOpen((open) => !open),
          }}
          onKey={(key) => ctrl({ type: "KeyPress", key })}
          onClipboardShortcut={(key) => {
            releaseHeldInput();
            ctrl({ type: "KeyDown", key: "control" });
            ctrl({ type: "KeyChar", char: key });
            ctrl({ type: "KeyUp", key: "control" });
          }}
          view={{
            enabled: streamEnabled,
            zoom: input.zoom,
            onZoomIn: () => {
              releaseHeldInput();
              setZoom((value) => Math.min(4, value + 0.5));
            },
            onZoomOut: () => {
              releaseHeldInput();
              setZoom((value) => Math.max(1, value - 0.5));
              setPan({ x: 0, y: 0 });
            },
            onFit: () => {
              releaseHeldInput();
              setZoom(1);
              setPan({ x: 0, y: 0 });
            },
          }}
          stream={{
            disabled: !streamEnabled || blockedByRole,
            preset: stream.preset,
            onPreset: (preset) => {
              applyStreamPreset(preset);
              closeTools();
            },
            monitors: monitorSelection.options,
            selectedMonitor: monitorSelection.selected,
            onMonitor: (index) => {
              applyMonitor(index);
              closeTools();
            },
            onReconnect: canReconnect
              ? () => {
                  reconnectStream();
                  closeTools();
                }
              : null,
          }}
          audio={{
            ...audioControls,
            onToggle: toggleAudio,
          }}
          fullscreenControl={fullscreenControl}
          onNotify={
            inputEnabled
              ? () => {
                  releaseHeldInput();
                  closeTools();
                  setShowNotificationModal(true);
                }
              : null
          }
          activeApp={placeholderSub}
        />
      )}
    </>
  );
}

function useRemoteInputRejection(
  agentId: string,
  disableInput: () => void,
  releaseLease: () => void,
  setInputError: (error: string) => void,
) {
  useWsEvent("command_rejected", (message) => {
    if (message.agent_id !== agentId || message.module !== "remote_input") return;
    disableInput();
    releaseLease();
    setInputError(
      typeof message.error === "string"
        ? message.error
        : "Remote input rejected. Check module permissions.",
    );
  });
}
function useViewportHeight(container: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () =>
      container.current?.style.setProperty(
        "--remote-viewport-height",
        `${viewport?.height ?? window.innerHeight}px`,
      );
    update();
    viewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
    };
  }, [container]);
}
function remoteMonitorSelection(
  info: AgentInfo | null | undefined,
  enabled: boolean,
  index: number | null,
) {
  const monitors = info?.monitors ?? [];
  const primary = Math.max(
    0,
    monitors.findIndex((m) => m.primary),
  );
  return {
    options: enabled && monitors.length > 1 ? monitors : null,
    selected: index ?? primary,
  };
}
function remoteAudioControls(
  audio: ReturnType<typeof useDesktopAudio>,
  source: ReturnType<typeof useScreenStream>["source"],
  canOperate: boolean,
  available: boolean,
  online: boolean,
  awaitingGesture: boolean,
) {
  return {
    show: available && canOperate,
    disabled: !online || !source.audio,
    active: audio.active,
    awaitingGesture,
    note: audio.error || source.audioNote,
  };
}

function showInputOverlay(enabled: boolean, inputEnabled: boolean, action: string): boolean {
  return enabled && (inputEnabled || action === "pan");
}
function showTrackpadCursor(mode: string, cursor: unknown): boolean {
  return mode === "trackpad" && Boolean(cursor);
}

/** Own transient panel state and reset it before a changed viewing scope commits. */
function useRemotePanels(sheetScope: string, streamScope: string, enabled: boolean) {
  const [showNotificationModal, setShowNotificationModal] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [clipboardTriggerUsed, setClipboardTriggerUsed] = useState(false);
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [previousSheet, setPreviousSheet] = useState(sheetScope);
  if (previousSheet !== sheetScope) {
    setPreviousSheet(sheetScope);
    setClipboardOpen(false);
    setToolsOpen(false);
  }
  const [previousStream, setPreviousStream] = useState(streamScope);
  if (previousStream !== streamScope) {
    setPreviousStream(streamScope);
    if (!enabled) {
      setToolsOpen(false);
      setClipboardOpen(false);
      setKeyboardOpen(false);
      setShowNotificationModal(false);
    }
  }
  return {
    showNotificationModal,
    setShowNotificationModal,
    toolsOpen,
    setToolsOpen,
    clipboardTriggerUsed,
    setClipboardTriggerUsed,
    clipboardOpen,
    setClipboardOpen,
    keyboardOpen,
    setKeyboardOpen,
  };
}
