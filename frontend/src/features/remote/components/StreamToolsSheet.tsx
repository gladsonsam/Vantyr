import type { RefObject } from "react";
import { Volume2, VolumeX } from "lucide-react";
import type { MonitorInfo } from "@/api/types";
import { STREAM_PRESET_OPTIONS, monitorLabel, type StreamPreset } from "@/features/remote/lib/streamPresets";
import type { TouchAction, TouchMode } from "@/features/remote/lib/remoteTouch";
import { RemoteClipboardPanel } from "./RemoteClipboardPanel";
import { RemoteToolGroup, RemoteToolsSheet } from "./RemoteToolsSheet";

const REMOTE_KEYS: [label: string, key: string][] = [
  ["Tab", "tab"], ["Esc", "escape"], ["Enter", "enter"], ["←", "arrowleft"], ["↑", "arrowup"], ["↓", "arrowdown"], ["→", "arrowright"],
];

/** "More tools": gestures, clipboard, remote keys, view & stream, audio & notification, help. */
export function StreamToolsSheet({
  triggerRef,
  onClose,
  message,
  control,
  touch,
  clipboard,
  onKey,
  view,
  stream,
  audio,
  onNotify,
  activeApp,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  /** Error (alert) or connection note (status) shown at the top. */
  message: { text: string; alert: boolean };
  control: { agentId: string; inputEnabled: boolean; pointerEnabled: boolean; leaseToken: string | null };
  touch: { mode: TouchMode; action: TouchAction; onMode: (mode: TouchMode) => void; onAction: (action: TouchAction) => void };
  clipboard: { open: boolean; supported: boolean; onToggle: () => void };
  onKey: (key: string) => void;
  view: { enabled: boolean; zoom: number; onZoomIn: () => void; onZoomOut: () => void; onFit: () => void };
  stream: {
    disabled: boolean;
    preset: StreamPreset;
    onPreset: (preset: StreamPreset) => void;
    monitors: MonitorInfo[] | null;
    selectedMonitor: number;
    onMonitor: (index: number) => void;
    onReconnect: (() => void) | null;
  };
  audio: { show: boolean; disabled: boolean; active: boolean; onToggle: () => void; note?: string };
  onNotify: (() => void) | null;
  activeApp?: string;
}) {
  const { agentId, inputEnabled, pointerEnabled, leaseToken } = control;
  return (
    <RemoteToolsSheet triggerRef={triggerRef} onClose={onClose}>
      {message.text && <p className="remote-tool-hint" role={message.alert ? "alert" : "status"}>{message.text}</p>}
      <RemoteToolGroup title="Pointer & gestures">
        <div className="remote-tool-fields">
          <label>Touch mode <select aria-label="Touch mode" value={touch.mode} onChange={event => touch.onMode(event.target.value as TouchMode)}><option value="direct">Direct touch</option><option value="trackpad">Trackpad</option></select></label>
          <label>Touch action <select aria-label="Touch action" value={touch.action} onChange={event => touch.onAction(event.target.value as TouchAction)}>
            <option value="tap" disabled={!pointerEnabled}>Tap / move pointer</option><option value="right" disabled={!pointerEnabled}>Right click</option><option value="drag" disabled={!pointerEnabled}>Drag</option><option value="scroll" disabled={!inputEnabled}>Scroll</option><option value="pan">Pan local view</option>
          </select></label>
        </div>
        <p className="remote-tool-hint">Trackpad: swipe moves, tap clicks.</p>
      </RemoteToolGroup>
      <section className="remote-tool-group">
        <button type="button" className="remote-tool-group-toggle" aria-expanded={clipboard.open} onClick={clipboard.onToggle}>Text clipboard<span aria-hidden="true">{clipboard.open ? "−" : "+"}</span></button>
        {clipboard.open && <div className="remote-tool-group-content">{inputEnabled && leaseToken ? <RemoteClipboardPanel key={`${agentId}:${leaseToken}`} agentId={agentId} controlToken={leaseToken} supported={clipboard.supported} /> : <p role="status">Take control to use the clipboard.</p>}</div>}
      </section>
      <RemoteToolGroup title="Remote keys">
        <div className="remote-shortcuts">{REMOTE_KEYS.map(([label, key]) => <button key={key} type="button" disabled={!inputEnabled} aria-label={`Remote ${key}`} onClick={() => onKey(key)}>{label}</button>)}</div>
      </RemoteToolGroup>
      <RemoteToolGroup title="View & stream">
        <div className="remote-tool-buttons">
          <button type="button" aria-label="Zoom in locally" disabled={!view.enabled || view.zoom >= 4} onClick={view.onZoomIn}>Zoom +</button>
          <button type="button" aria-label="Zoom out locally" disabled={!view.enabled || view.zoom <= 1} onClick={view.onZoomOut}>Zoom −</button>
          <button type="button" onClick={view.onFit}>Fit view ({view.zoom}×)</button>
        </div>
        <div className="remote-tool-fields">
          <label>Stream quality <select aria-label="Stream quality" disabled={stream.disabled} value={stream.preset} onChange={event => stream.onPreset(event.target.value as StreamPreset)}>{STREAM_PRESET_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          {stream.monitors && <label>Monitor <select aria-label="Monitor" disabled={stream.disabled} value={stream.selectedMonitor} onChange={event => stream.onMonitor(Number(event.target.value))}>{stream.monitors.map((monitor, index) => <option key={index} value={index}>{monitorLabel(monitor, index)}</option>)}</select></label>}
        </div>
        {stream.onReconnect && <button type="button" onClick={stream.onReconnect}>Reconnect live view</button>}
      </RemoteToolGroup>
      <RemoteToolGroup title="Audio & notification">
        <div className="remote-tool-buttons">
          {audio.show && <button type="button" disabled={audio.disabled} aria-pressed={audio.active} onClick={audio.onToggle}>{audio.active ? <Volume2 size={17} aria-hidden="true" /> : <VolumeX size={17} aria-hidden="true" />}{audio.active ? "Mute desktop audio" : "Hear desktop audio"}</button>}
          <button type="button" disabled={!onNotify} onClick={() => onNotify?.()}>Send notification</button>
        </div>
        {audio.note && <p className="remote-tool-hint">{audio.note}</p>}
      </RemoteToolGroup>
      <RemoteToolGroup title="Help">
        <p className="remote-tool-hint">Pan and zoom only change your view.</p>
        <p className="remote-tool-hint">Control ends on focus loss or a display change. Ctrl+Alt+Del is unavailable.</p>
        {activeApp && <p className="remote-tool-hint">Active app: {activeApp}</p>}
      </RemoteToolGroup>
    </RemoteToolsSheet>
  );
}
