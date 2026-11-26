import type { RefObject } from "react";
import {
  ChevronDown,
  Clipboard,
  Keyboard,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  MousePointer2,
  RefreshCw,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { useImmersiveChrome } from "@/features/remote/hooks/useImmersiveChrome";
import { RemoteSoftwareKeyboard, type RemoteKeyboardHandle } from "./RemoteSoftwareKeyboard";

/**
 * The four primary live-screen actions (take/release control, software keyboard, more tools,
 * maximize), the current error or connection note, and the keyboard tray.
 */
type ToolbarProps = {
  control: {
    active: boolean;
    acquiring: boolean;
    allowed: boolean;
    /** Another viewer holds the control lease. */
    busy: boolean;
    onToggle: () => void;
    /** Maximize and take control in one click. */
    onFullscreen: () => void;
    fullscreenActive: boolean;
  };
  /** Keyboard note beside the session mode (empty when there is nothing to say). */
  hint: string;
  keyboard: {
    open: boolean;
    enabled: boolean;
    ref: RefObject<RemoteKeyboardHandle | null>;
    onToggle: () => void;
    onText: (text: string) => boolean;
  };
  tools: {
    open: boolean;
    triggerRef: RefObject<HTMLButtonElement | null>;
    onOpen: () => void;
  };
  maximize: {
    maximized: boolean;
    disabled: boolean;
    onToggle: () => void;
    title?: string;
  };
  clipboard: {
    ref: RefObject<HTMLButtonElement | null>;
    open: boolean;
    enabled: boolean;
    onOpen: () => void;
  };
  audio: {
    show: boolean;
    active: boolean;
    connecting: boolean;
    disabled: boolean;
    /** Sound is wanted but the browser has not allowed it yet (needs a click). */
    awaitingGesture?: boolean;
    onToggle: () => void;
  };
  onReconnect: (() => void) | null;
  /** Input or control error (announced as an alert). */
  error: string;
  /** Why control is unavailable or what the stream is doing. */
  note: string;
  /**
   * Maximized view: the toolbar becomes an on-demand overlay behind a corner handle, and only
   * errors stay visible. Null in the windowed layout.
   */
  immersive: ReturnType<typeof useImmersiveChrome> | null;
};

export function StreamToolbar({
  control,
  hint,
  keyboard: {
    open: keyboardOpen,
    enabled: keyboardEnabled,
    ref: keyboardRef,
    onToggle: onToggleKeyboard,
    onText: onKeyboardText,
  },
  tools: { open: toolsOpen, triggerRef, onOpen: onOpenTools },
  maximize,
  clipboard: {
    ref: clipboardRef,
    open: clipboardOpen,
    enabled: clipboardEnabled,
    onOpen: onOpenClipboard,
  },
  audio,
  onReconnect,
  error,
  note,
  immersive,
}: ToolbarProps) {
  return (
    <>
      {immersive && <ImmersiveHandle chrome={immersive} />}
      {immersive && error && (
        <div className="remote-fs-alert">
          <ConnectionNote error={error} note="" />
        </div>
      )}
      <div
        {...(immersive?.panel ?? {})}
        id={immersive ? IMMERSIVE_PANEL_ID : undefined}
        className={`screen-remote-tools${immersive ? " is-immersive" : ""}${immersive?.visible ? " is-revealed" : ""}`}
        aria-label="Remote input tools"
        inert={immersive ? !immersive.visible : undefined}
      >
        <SessionStatus
          active={control.active}
          busy={control.busy}
          hint={hint}
          immersive={immersive !== null}
        />
        <div className="remote-primary-actions">
          <div className="remote-control-group">
            <ControlButton control={control} />
            <FullscreenControlButton control={control} />
          </div>
          <div className="remote-quiet-tools">
            <button
              type="button"
              data-short-label="Keyboard"
              aria-label="Software keyboard"
              title="Software keyboard"
              disabled={!keyboardEnabled}
              aria-expanded={keyboardOpen}
              className={keyboardOpen ? "is-active" : ""}
              onClick={onToggleKeyboard}
            >
              <Keyboard size={18} aria-hidden="true" />
              <span className="remote-tool-label">Keyboard</span>
            </button>
            <button
              ref={clipboardRef}
              type="button"
              data-short-label="Clipboard"
              aria-label="Open clipboard"
              title="Transfer text between this browser and the device"
              aria-haspopup="dialog"
              aria-expanded={clipboardOpen}
              disabled={!clipboardEnabled}
              onClick={onOpenClipboard}
            >
              <Clipboard size={18} aria-hidden="true" />
              <span className="remote-tool-label">Clipboard</span>
            </button>
            <AudioButton audio={audio} />
            {onReconnect && (
              <button
                type="button"
                data-short-label="Reconnect"
                aria-label="Reconnect live view"
                onClick={onReconnect}
              >
                <RefreshCw size={18} aria-hidden="true" />
                <span className="remote-tool-label">Reconnect</span>
              </button>
            )}
            <button
              ref={triggerRef}
              type="button"
              data-short-label="Tools"
              aria-label="More tools"
              title="More tools"
              aria-haspopup="dialog"
              aria-expanded={toolsOpen}
              onClick={onOpenTools}
            >
              <MoreHorizontal size={19} aria-hidden="true" />
              <span className="remote-tool-label">More tools</span>
            </button>
            <MaximizeButton maximize={maximize} />
          </div>
        </div>
        {!immersive && <ConnectionNote error={error} note={note} />}
        {keyboardOpen && (
          <div className="remote-keyboard-tray">
            <RemoteSoftwareKeyboard
              ref={keyboardRef}
              enabled={keyboardEnabled}
              onText={onKeyboardText}
            />
          </div>
        )}
      </div>
    </>
  );
}

/** Mode and keyboard hint; maximized, only the hint stays (the desktop itself shows the mode). */
function SessionStatus({
  active,
  busy,
  hint,
  immersive,
}: {
  active: boolean;
  busy: boolean;
  hint: string;
  immersive: boolean;
}) {
  if (immersive && !hint) return null;
  return (
    <div className="remote-session-status">
      {!immersive && (
        <span className={`remote-session-mode${active ? " is-controlling" : ""}`}>
          <span className="remote-session-dot" aria-hidden="true" />
          {active ? "Controlling" : busy ? "Someone else is controlling" : "Viewing"}
        </span>
      )}
      {hint && (
        <span className="remote-input-hint" aria-live="polite">
          {hint}
        </span>
      )}
    </div>
  );
}

function ConnectionNote({ error, note }: { error: string; note: string }) {
  if (error) {
    return (
      <span className="remote-connection-note" role="alert">
        {error}
      </span>
    );
  }
  return note ? (
    <span className="remote-connection-note" role="status">
      {note}
    </span>
  ) : null;
}

const IMMERSIVE_PANEL_ID = "remote-fullscreen-controls";

/** Small corner tab that reveals the maximized view's controls; it never covers the top edge. */
function ImmersiveHandle({ chrome }: { chrome: NonNullable<ToolbarProps["immersive"]> }) {
  return (
    <button
      {...chrome.handle}
      type="button"
      className={`remote-fs-handle${chrome.visible ? " is-revealed" : ""}`}
      aria-label="View controls"
      title="View controls"
      aria-expanded={chrome.visible}
      aria-controls={IMMERSIVE_PANEL_ID}
    >
      <ChevronDown size={16} aria-hidden="true" />
    </button>
  );
}

function ControlButton({ control }: Pick<ToolbarProps, "control">) {
  const controlLabel = control.active
    ? "Release control"
    : control.acquiring
      ? "Requesting control"
      : "Take control";
  return (
    <button
      type="button"
      data-short-label={control.active ? "Release" : control.acquiring ? "Wait…" : "Control"}
      className={`remote-control-button${control.active ? " is-controlling" : ""}`}
      aria-label={controlLabel}
      aria-pressed={control.active}
      title={controlLabel}
      disabled={!control.allowed || control.acquiring}
      onClick={control.onToggle}
    >
      <MousePointer2 size={17} aria-hidden="true" />
      <span>
        {control.active ? "Release control" : control.acquiring ? "Requesting…" : "Take control"}
      </span>
    </button>
  );
}

/** Takes control and goes fullscreen from one click; hidden once either is already done. */
function FullscreenControlButton({ control }: Pick<ToolbarProps, "control">) {
  if (control.active || control.fullscreenActive) return null;
  return (
    <button
      type="button"
      data-short-label="Full control"
      className="remote-control-button"
      aria-label="Control in fullscreen"
      title="Take control and go fullscreen"
      disabled={!control.allowed || control.acquiring}
      onClick={control.onFullscreen}
    >
      <Maximize2 size={17} aria-hidden="true" />
      <span>Fullscreen control</span>
    </button>
  );
}

function AudioButton({ audio }: Pick<ToolbarProps, "audio">) {
  if (!audio.show) return null;
  const text = audio.connecting ? "Connecting…" : audio.active ? "Sound on" : "Sound off";
  const title = audio.awaitingGesture ? "Click to enable sound" : undefined;
  const label = audio.connecting
    ? "Cancel desktop audio"
    : audio.active
      ? "Mute desktop audio"
      : "Hear desktop audio";
  return (
    <button
      type="button"
      data-short-label={text}
      aria-label={label}
      aria-pressed={audio.active}
      title={title ?? label}
      disabled={audio.disabled}
      className={audio.active ? "is-active" : ""}
      onClick={audio.onToggle}
    >
      {audio.active ? (
        <Volume2 size={18} aria-hidden="true" />
      ) : (
        <VolumeX size={18} aria-hidden="true" />
      )}
      <span className="remote-tool-label">{text}</span>
    </button>
  );
}

function MaximizeButton({ maximize }: Pick<ToolbarProps, "maximize">) {
  const maximizeLabel = maximize.maximized ? "Exit fullscreen" : "Maximize view";
  return (
    <button
      type="button"
      data-short-label={maximize.maximized ? "Exit" : "Expand"}
      aria-label={maximizeLabel}
      title={maximize.title ?? maximizeLabel}
      disabled={maximize.disabled}
      onClick={maximize.onToggle}
    >
      {maximize.maximized ? (
        <Minimize2 size={18} aria-hidden="true" />
      ) : (
        <Maximize2 size={18} aria-hidden="true" />
      )}
      <span className="remote-tool-label remote-fullscreen-label">
        {maximize.maximized ? "Exit fullscreen" : "Fullscreen"}
      </span>
    </button>
  );
}
