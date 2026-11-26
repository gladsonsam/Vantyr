import type { RefObject } from "react";
import {
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
import { RemoteSoftwareKeyboard, type RemoteKeyboardHandle } from "./RemoteSoftwareKeyboard";

/**
 * The four primary live-screen actions (take/release control, software keyboard, more tools,
 * maximize), the current error or connection note, and the keyboard tray.
 */
type ToolbarProps = {
  control: { active: boolean; acquiring: boolean; allowed: boolean; onToggle: () => void };
  /** Keyboard note beside the session mode (empty when there is nothing to say). */
  hint: string;
  keyboard: {
    open: boolean;
    enabled: boolean;
    ref: RefObject<RemoteKeyboardHandle | null>;
    onToggle: () => void;
    onText: (text: string) => boolean;
  };
  tools: { open: boolean; triggerRef: RefObject<HTMLButtonElement | null>; onOpen: () => void };
  maximize: { maximized: boolean; disabled: boolean; onToggle: () => void; title?: string };
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
    onToggle: () => void;
  };
  onReconnect: (() => void) | null;
  /** Input or control error (announced as an alert). */
  error: string;
  /** Why control is unavailable or what the stream is doing. */
  note: string;
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
}: ToolbarProps) {
  return (
    <div className="screen-remote-tools" aria-label="Remote input tools">
      <div className="remote-session-status">
        <span className={`remote-session-mode${control.active ? " is-controlling" : ""}`}>
          {control.active ? "You’re controlling this desktop" : "Viewing desktop"}
        </span>
        {hint && (
          <span className="remote-input-hint" aria-live="polite">
            {hint}
          </span>
        )}
      </div>
      <div className="remote-primary-actions">
        <ControlButton control={control} />
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
          <span>Keyboard</span>
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
          <span>Clipboard</span>
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
            <span>Reconnect</span>
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
          <span>More tools</span>
        </button>
        <MaximizeButton maximize={maximize} />
      </div>
      {error ? (
        <span className="remote-connection-note" role="alert">
          {error}
        </span>
      ) : note ? (
        <span className="remote-connection-note" role="status">
          {note}
        </span>
      ) : null}
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

function AudioButton({ audio }: Pick<ToolbarProps, "audio">) {
  if (!audio.show) return null;
  const text = audio.connecting ? "Connecting…" : audio.active ? "Sound on" : "Sound off";
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
      title={label}
      disabled={audio.disabled}
      className={audio.active ? "is-active" : ""}
      onClick={audio.onToggle}
    >
      {audio.active ? (
        <Volume2 size={18} aria-hidden="true" />
      ) : (
        <VolumeX size={18} aria-hidden="true" />
      )}
      <span>{text}</span>
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
      <span className="remote-fullscreen-label">
        {maximize.maximized ? "Exit fullscreen" : "Fullscreen"}
      </span>
    </button>
  );
}
