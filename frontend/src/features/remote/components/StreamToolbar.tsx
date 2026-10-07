import type { RefObject } from "react";
import { Keyboard, Maximize2, Minimize2, MoreHorizontal, MousePointer2 } from "lucide-react";
import { RemoteSoftwareKeyboard, type RemoteKeyboardHandle } from "./RemoteSoftwareKeyboard";

/**
 * The four primary live-screen actions (take/release control, software keyboard, more tools,
 * maximize), the current error or connection note, and the keyboard tray.
 */
export function StreamToolbar({
  control,
  keyboard,
  tools,
  maximize,
  error,
  note,
}: {
  control: { active: boolean; acquiring: boolean; allowed: boolean; onToggle: () => void };
  keyboard: { open: boolean; enabled: boolean; ref: RefObject<RemoteKeyboardHandle | null>; onToggle: () => void; onText: (text: string) => boolean };
  tools: { open: boolean; triggerRef: RefObject<HTMLButtonElement | null>; onOpen: () => void };
  maximize: { maximized: boolean; disabled: boolean; onToggle: () => void };
  /** Input or control error (announced as an alert). */
  error: string;
  /** Why control is unavailable or what the stream is doing. */
  note: string;
}) {
  const controlLabel = control.active ? "Release control" : control.acquiring ? "Requesting control" : "Take control";
  const maximizeLabel = maximize.maximized ? "Exit fullscreen" : "Maximize view";
  return (
    <div className="screen-remote-tools" aria-label="Remote input tools">
      <div className="remote-primary-actions">
        <button type="button" data-short-label={control.active ? "Release" : control.acquiring ? "Wait…" : "Control"} className={`remote-control-button${control.active ? " is-controlling" : ""}`} aria-label={controlLabel} title={controlLabel} disabled={!control.allowed || control.acquiring} onClick={control.onToggle}>
          <MousePointer2 size={17} aria-hidden="true" /><span>{control.active ? "Release control" : control.acquiring ? "Requesting…" : "Take control"}</span>
        </button>
        <button type="button" data-short-label="Keyboard" aria-label="Software keyboard" title="Software keyboard" disabled={!keyboard.enabled} aria-expanded={keyboard.open} className={keyboard.open ? "is-active" : ""} onClick={keyboard.onToggle}><Keyboard size={18} aria-hidden="true" /><span>Keyboard</span></button>
        <button ref={tools.triggerRef} type="button" data-short-label="Tools" aria-label="More tools" title="More tools" aria-haspopup="dialog" aria-expanded={tools.open} onClick={tools.onOpen}><MoreHorizontal size={19} aria-hidden="true" /><span>More tools</span></button>
        <button type="button" data-short-label={maximize.maximized ? "Exit" : "Expand"} aria-label={maximizeLabel} title={maximizeLabel} disabled={maximize.disabled} onClick={maximize.onToggle}>{maximize.maximized ? <Minimize2 size={18} aria-hidden="true" /> : <Maximize2 size={18} aria-hidden="true" />}<span className="remote-fullscreen-label">{maximize.maximized ? "Exit fullscreen" : "Fullscreen"}</span></button>
      </div>
      {error ? <span className="remote-connection-note" role="alert">{error}</span> : note ? <span className="remote-connection-note" role="status">{note}</span> : null}
      {keyboard.open && <div className="remote-keyboard-tray"><RemoteSoftwareKeyboard ref={keyboard.ref} enabled={keyboard.enabled} onText={keyboard.onText} /></div>}
    </div>
  );
}
