import "./screen-remote.css";
import { Container, Header, Box, SpaceBetween, Button, Toggle, FormField, Modal, Input, Select, Alert } from "../ui/console";
import { Monitor, Maximize2, Minimize2, MousePointer2, Volume2, VolumeX } from "lucide-react";
import { useCallback, useState, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { mjpegStreamUrl, notifyMjpegViewerLeft, apiUrl, type MjpegStreamTuning } from "../../lib/api";
import { StreamStatus } from "../common/StatusIndicator";
import type { AgentInfo, DashboardRole, MonitorInfo } from "../../lib/types";
import { capabilityAvailable, capabilityFullySupported, capabilityStatus } from "../../lib/agentCapabilities";
import { isDemoMode } from "../../demo/mode";
import { DemoScreen } from "../../demo/fakeScreen";
import { remoteImagePoint } from "../../lib/remotePointer";
import { RemoteSoftwareKeyboard, type RemoteKeyboardHandle } from "./RemoteSoftwareKeyboard";
import { cursorLocation, clampPan, remoteTextChunks, touchPoint, type Point, type TouchMode, type TouchAction } from "./remoteTouch";
import { RemoteHeldInput } from "../../lib/remoteHeldInput";

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

type StreamPreset = "saver" | "balanced" | "sharp" | "ultra";

const STREAM_PRESET_STORAGE_KEY = "vantyr.dashboard.screenStreamPreset";

const STREAM_PRESET_TUNING: Record<StreamPreset, MjpegStreamTuning> = {
  saver:    { jpegQ: 28, intervalMs: 500 },
  balanced: { jpegQ: 40, intervalMs: 200 },
  sharp:    { jpegQ: 62, intervalMs: 80  },
  ultra:    { jpegQ: 75, intervalMs: 33  },
};

const STREAM_PRESET_OPTIONS: Array<{ label: string; description: string; value: StreamPreset }> = [
  { label: "Bandwidth saver", description: "~2 fps — minimal bandwidth, best for slow connections.", value: "saver" },
  { label: "Balanced",        description: "~5 fps — default viewing profile.",                       value: "balanced" },
  { label: "Sharp",           description: "~12 fps — higher quality, more bandwidth.",               value: "sharp" },
  { label: "Ultra (~30 fps)", description: "~30 fps — lowest latency, high CPU + network usage.",     value: "ultra" },
];

function loadStreamPreset(): StreamPreset {
  try {
    const raw = localStorage.getItem(STREAM_PRESET_STORAGE_KEY);
    if (raw === "saver" || raw === "balanced" || raw === "sharp" || raw === "ultra") return raw;
  } catch {
    /* ignore */
  }
  return "balanced";
}

function saveStreamPreset(preset: StreamPreset) {
  try {
    localStorage.setItem(STREAM_PRESET_STORAGE_KEY, preset);
  } catch {
    /* ignore */
  }
}

/** Human-readable label for a monitor option (name + resolution + primary marker). */
function monitorLabel(m: MonitorInfo, i: number): string {
  const base = m.name?.trim() || `Display ${i + 1}`;
  const res = m.width && m.height ? ` (${m.width}×${m.height})` : "";
  const primary = m.primary ? " • Primary" : "";
  return `${base}${res}${primary}`;
}

// ─── Keyboard helpers ────────────────────────────────────────────────────────

/** Browser KeyboardEvent.key values that map to SpecialKey enum variants. */
const SPECIAL_KEY_MAP: Record<string, string> = {
  Enter: "enter", Backspace: "backspace", Tab: "tab", Escape: "escape",
  Delete: "delete", Insert: "insert", " ": "space",
  Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
  ArrowUp: "arrowup", ArrowDown: "arrowdown", ArrowLeft: "arrowleft", ArrowRight: "arrowright",
  F1: "f1", F2: "f2", F3: "f3", F4: "f4", F5: "f5", F6: "f6",
  F7: "f7", F8: "f8", F9: "f9", F10: "f10", F11: "f11", F12: "f12",
  CapsLock: "capslock",
};

/** Keys that are modifier keys — sent as KeyDown/KeyUp not KeyPress. */
const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

/** Returns true for printable single characters (not modifiers, not specials). */
function isPrintable(key: string): boolean {
  return Array.from(key).length === 1 && !MODIFIER_KEYS.has(key);
}

/**
 * Map a pointer position (clientX/Y) to remote-host pixel coordinates.
 *
 * The stream image uses `objectFit: contain`, so the rendered pixels may be
 * letterboxed / pillarboxed inside the element's CSS box (especially in
 * fullscreen where the viewport ratio can differ from the stream ratio).
 * We compute the actual rendered image area first, then map into it.
 */
function pointerToImageCoords(
  img: HTMLImageElement,
  clientX: number,
  clientY: number,
  clampDrag = false,
): { x: number; y: number } | null {
  return remoteImagePoint(img.getBoundingClientRect(), img.naturalWidth, img.naturalHeight, clientX, clientY, clampDrag);
}

function requestViewportFullscreen(el: HTMLElement): Promise<void> {
  const anyEl = el as HTMLElement & {
    webkitRequestFullscreen?: () => void;
    mozRequestFullScreen?: () => void;
  };
  if (typeof el.requestFullscreen === "function") return el.requestFullscreen();
  if (typeof anyEl.webkitRequestFullscreen === "function") {
    anyEl.webkitRequestFullscreen();
    return Promise.resolve();
  }
  if (typeof anyEl.mozRequestFullScreen === "function") {
    anyEl.mozRequestFullScreen();
    return Promise.resolve();
  }
  return Promise.resolve();
}

function exitViewportFullscreen(): Promise<void> {
  const doc = document as Document & {
    webkitExitFullscreen?: () => void;
    mozCancelFullScreen?: () => void;
  };
  if (typeof document.exitFullscreen === "function") return document.exitFullscreen();
  if (typeof doc.webkitExitFullscreen === "function") {
    doc.webkitExitFullscreen();
    return Promise.resolve();
  }
  if (typeof doc.mozCancelFullScreen === "function") {
    doc.mozCancelFullScreen();
    return Promise.resolve();
  }
  return Promise.resolve();
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
  const [streaming, setStreaming] = useState(false);
  const [streamEverLoaded, setStreamEverLoaded] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const [streamAspectRatio, setStreamAspectRatio] = useState<string | null>(null);
  const lastFrameAtMsRef = useRef<number | null>(null);
  const [remoteControl, setRemoteControl] = useState(false);
  const [controlAgentId, setControlAgentId] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  /** CSS-overlay "maximize" for touch/iOS where the Fullscreen API can't target a <div>. */
  const [pseudoFs, setPseudoFs] = useState(false);
  const [showNotificationModal, setShowNotificationModal] = useState(false);
  const [notificationTitle, setNotificationTitle] = useState("");
  const [notificationMessage, setNotificationMessage] = useState("");
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  /** Latest abort — avoids effect cleanups tied to `abortMjpeg` identity (session changes) clearing `<img src>`. */
  const abortMjpegRef = useRef<() => void>(() => {});

  // ── Audio ──────────────────────────────────────────────────────────────────
  const [audioActive, setAudioActive] = useState(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioAbortRef = useRef<AbortController | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  /** rAF token for batching mouse-move messages. */
  const rafMoveRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null);
  const heldInput = useRef(new RemoteHeldInput());
  const inputGeneration = useRef(0);
  const inputEnabledRef = useRef(false);
  const keyboardRef = useRef<RemoteKeyboardHandle>(null);
  const [touchMode, setTouchMode] = useState<TouchMode>("direct");
  const [touchAction, setTouchAction] = useState<TouchAction>("tap");
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [inputError, setInputError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const cursor = useRef<Point | null>(null);
  const [cursorPreview, setCursorPreview] = useState<Point | null>(null);
  const cursorMarker = useRef<HTMLSpanElement>(null);
  const gesture = useRef<{ id: number; start: Point; last: Point; point: Point; moved: boolean; scroll: Point; action: TouchAction } | null>(null);

  /** Per visit to the screen tab; server ties MJPEG GET + explicit leave to this id. */
  const [mjpegStreamSession, setMjpegStreamSession] = useState("");
  const [streamPreset, setStreamPreset] = useState<StreamPreset>(() => loadStreamPreset());
  /** Explicit monitor selection (0-based). `null` = let the agent pick its primary. */
  const [monitorIndex, setMonitorIndex] = useState<number | null>(null);

  const blockedByRole = dashboardRole !== "operator" && dashboardRole !== "admin";
  const screenAvailable = capabilityAvailable(agentInfo, "screen_capture");
  const audioAvailable = capabilityAvailable(agentInfo, "audio_capture");
  const remoteInputAvailable = capabilityFullySupported(agentInfo, "remote_input") && capabilityStatus(agentInfo, "remote_input")?.toLowerCase() === "supported";
  const streamEnabled = streamActive && screenAvailable;
  const remoteControlAllowed = online && streamEnabled && !blockedByRole && remoteInputAvailable;
  const inputEnabled = remoteControl && remoteControlAllowed && controlAgentId === agentId;
  inputEnabledRef.current = inputEnabled;

  const changeRemoteControl = (enabled: boolean) => {
    setControlAgentId(enabled && remoteControlAllowed ? agentId : null);
    setRemoteControl(enabled && remoteControlAllowed);
  };

  const stopAudio = useCallback(() => {
    audioAbortRef.current?.abort();
    audioAbortRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    nextPlayTimeRef.current = 0;
    setAudioActive(false);
  }, []);

  const startAudio = useCallback(async () => {
    stopAudio();
    if (isDemoMode || !online) return;

    const abort = new AbortController();
    audioAbortRef.current = abort;
    setAudioActive(true);

    try {
      const resp = await fetch(apiUrl(`/agents/${agentId}/audio`), {
        credentials: "include",
        signal: abort.signal,
      });
      if (!resp.ok || !resp.body) { stopAudio(); return; }

      const reader = resp.body.getReader();
      let metaBuf = new Uint8Array(0);
      let metaReady = false;
      let sampleRate = 48000;
      let channels = 2;
      let ctx: AudioContext | null = null;
      let remainder = new Uint8Array(0);

      while (true) {
        const { done, value } = await reader.read();
        if (done || abort.signal.aborted) break;
        if (!value || value.length === 0) continue;

        if (!metaReady) {
          const joined = new Uint8Array(metaBuf.length + value.length);
          joined.set(metaBuf); joined.set(value, metaBuf.length);
          metaBuf = joined;
          if (metaBuf.length < 6) continue;
          const view = new DataView(metaBuf.buffer);
          sampleRate = view.getUint32(0, true);
          channels = view.getUint16(4, true);
          metaReady = true;
          ctx = new AudioContext({ sampleRate });
          audioCtxRef.current = ctx;
          remainder = metaBuf.slice(6);
        } else {
          const joined = new Uint8Array(remainder.length + value.length);
          joined.set(remainder); joined.set(value, remainder.length);
          remainder = joined;
        }

        if (!ctx) continue;

        // Decode all complete Float32 samples from the accumulated buffer.
        const floatCount = Math.floor(remainder.length / 4);
        if (floatCount < channels) continue;

        const alignedCount = Math.floor(floatCount / channels) * channels;
        const usedBytes = alignedCount * 4;
        const pcm = remainder.slice(0, usedBytes);
        remainder = remainder.slice(usedBytes);

        const frameCount = alignedCount / channels;
        const audioBuf = ctx.createBuffer(channels, frameCount, sampleRate);
        const dataView = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        for (let ch = 0; ch < channels; ch++) {
          const channelData = audioBuf.getChannelData(ch);
          for (let i = 0; i < frameCount; i++) {
            channelData[i] = dataView.getFloat32((i * channels + ch) * 4, true);
          }
        }

        const source = ctx.createBufferSource();
        source.buffer = audioBuf;
        source.connect(ctx.destination);
        const now = ctx.currentTime;
        const startAt = Math.max(nextPlayTimeRef.current, now + 0.05);
        source.start(startAt);
        nextPlayTimeRef.current = startAt + audioBuf.duration;
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.warn("Audio stream error:", e);
      }
    }
    stopAudio();
  }, [agentId, online, stopAudio]);

  // Stop audio when agent goes offline or component unmounts.
  useEffect(() => {
    if (!online && audioActive) stopAudio();
  }, [online, audioActive, stopAudio]);
  useEffect(() => () => stopAudio(), [stopAudio]);

  // Demo mode has no MJPEG backend, so show a believable fake desktop instead of a
  // perpetual "Connecting…" placeholder — keeps the live screen (and promo footage) alive.
  const demoLive = isDemoMode && online;

  // If we haven't seen a frame update in a while, treat as stalled.
  const [isStalled, setIsStalled] = useState(false);
  useEffect(() => {
    if (!streamEnabled) {
      setIsStalled(false);
      return;
    }
    const t = window.setInterval(() => {
      const last = lastFrameAtMsRef.current;
      if (!last) {
        setIsStalled(false);
        return;
      }
      setIsStalled(Date.now() - last > 15_000);
    }, 1000);
    return () => window.clearInterval(t);
  }, [streamEnabled]);

  // When the browser tab returns from being hidden, the MJPEG HTTP stream is
  // often broken (browsers throttle/drop long-lived connections for background
  // tabs). Rotate the session to force a fresh connection on return.
  useEffect(() => {
    if (!streamEnabled) return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        setMjpegStreamSession((prev) => {
          if (prev) notifyMjpegViewerLeft(agentId, prev);
          return crypto.randomUUID();
        });
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [agentId, streamEnabled]);

  useEffect(() => {
    if (!streamEnabled) return;
    setMjpegStreamSession(crypto.randomUUID());
  }, [agentId, streamEnabled]);

  useEffect(() => {
    // Reset status when stream toggles or agent changes.
    setStreaming(false);
    setStreamEverLoaded(false);
    setStreamError(false);
    setStreamAspectRatio(null);
    lastFrameAtMsRef.current = null;
  }, [agentId, streamEnabled, mjpegStreamSession]);

  const streamTuning = STREAM_PRESET_TUNING[streamPreset];

  // Monitor picker (only shown when the agent reports more than one monitor).
  const monitors = agentInfo?.monitors ?? [];
  const showMonitorPicker = streamEnabled && monitors.length > 1;
  const primaryMonitorIndex = Math.max(0, monitors.findIndex((m) => m.primary));
  const selectedMonitorIndex = monitorIndex ?? primaryMonitorIndex;

  const streamUrl = useMemo(
    () =>
      streamEnabled && mjpegStreamSession
        ? mjpegStreamUrl(agentId, mjpegStreamSession, streamTuning, monitorIndex ?? undefined)
        : "",
    [streamEnabled, agentId, mjpegStreamSession, streamTuning, monitorIndex],
  );

  const applyStreamPreset = useCallback(
    (next: StreamPreset) => {
      setStreamPreset(next);
      saveStreamPreset(next);

      if (!streamEnabled) return;

      // Rotate MJPEG session so the GET request picks up new tuning query params immediately.
      setMjpegStreamSession((prev) => {
        if (prev) notifyMjpegViewerLeft(agentId, prev);
        return crypto.randomUUID();
      });
    },
    [agentId, streamEnabled],
  );

  const applyMonitor = useCallback(
    (next: number) => {
      setMonitorIndex(next);

      if (!streamEnabled) return;

      // Rotate the MJPEG session so the new `?monitor=` param starts a fresh
      // capture immediately. The server rejects a reused session id, so we must
      // mint a new one (same pattern as the stream-quality change above).
      setMjpegStreamSession((prev) => {
        if (prev) notifyMjpegViewerLeft(agentId, prev);
        return crypto.randomUUID();
      });
    },
    [agentId, streamEnabled],
  );

  useEffect(() => {
    if (!streamActive || !remoteControlAllowed) setRemoteControl(false);
  }, [streamActive, remoteControlAllowed]);

  // Drop any monitor selection when switching agents — indices aren't comparable
  // across machines, so fall back to the new agent's primary.
  useEffect(() => {
    setMonitorIndex(null);
  }, [agentId]);

  /** Drop MJPEG and notify the server immediately so the agent gets `stop_capture` without waiting on the browser. */
  const abortMjpeg = useCallback(() => {
    const el = imgRef.current;
    if (el) {
      el.removeAttribute("src");
      el.src = "";
      el.removeAttribute("srcset");
    }
    setStreaming(false);
    if (mjpegStreamSession) {
      notifyMjpegViewerLeft(agentId, mjpegStreamSession);
    }
  }, [agentId, mjpegStreamSession]);

  abortMjpegRef.current = abortMjpeg;

  useLayoutEffect(() => {
    if (!streamEnabled) abortMjpegRef.current();
  }, [streamEnabled]);

  useEffect(() => {
    if (!streamEnabled) {
      setPseudoFs(false);
      const wrap = containerRef.current;
      if (wrap && document.fullscreenElement === wrap) {
        void document.exitFullscreen();
      }
    }
  }, [streamEnabled]);

  // Pseudo-fullscreen (CSS overlay): lock body scroll and allow Escape/back to exit,
  // since the native `fullscreenchange` event won't fire for this path.
  useEffect(() => {
    if (!pseudoFs) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPseudoFs(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [pseudoFs]);

  useEffect(() => {
    return () => {
      abortMjpegRef.current();
      // Cancel any pending rAF move flush on unmount.
      if (rafMoveRef.current) cancelAnimationFrame(rafMoveRef.current);
    };
  }, []);

  // Auto-focus overlay so keyboard events are captured immediately when
  // remote control is toggled on.
  useEffect(() => {
    if (inputEnabled) {
      overlayRef.current?.focus();
    }
  }, [inputEnabled]);

  // ─── Remote control helpers ────────────────────────────────────────────────

  const ctrl = useCallback(
    (cmd: Record<string, unknown>, release = false) => {
      // All new input goes through this guard; future lease checks belong here.
      // Only cleanup of this viewer's remembered held input can bypass revocation.
      if (!inputEnabledRef.current && !(release && (cmd.type === "KeyUp" || cmd.type === "MouseUp"))) return;
      sendWsMessage({ type: "control", agent_id: agentId, cmd });
    },
    [agentId, sendWsMessage],
  );

  const releaseHeldInput = useCallback(() => {
    inputGeneration.current++;
    gesture.current = null;
    keyboardRef.current?.cancel();
    if (rafMoveRef.current != null) cancelAnimationFrame(rafMoveRef.current);
    rafMoveRef.current = null;
    pendingMoveRef.current = null;
    heldInput.current.releaseAll().forEach(cmd => ctrl(cmd, true));
  }, [ctrl]);
  const releasePointer = useCallback(() => {
    gesture.current = null;
    heldInput.current.releaseButtons().forEach(cmd => ctrl(cmd, true));
  }, [ctrl]);
  useEffect(() => {
    if (!inputEnabled) { releaseHeldInput(); return; }
    const onVisibility = () => { if (document.hidden) releaseHeldInput(); };
    window.addEventListener("blur", releaseHeldInput);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", releaseHeldInput);
      document.removeEventListener("visibilitychange", onVisibility);
      releaseHeldInput();
    };
  }, [inputEnabled, monitorIndex, releaseHeldInput]);

  useEffect(() => {
    const onServerEvent = (event: Event) => {
      const message = (event as CustomEvent<Record<string, unknown>>).detail;
      if (!message || message.agent_id !== agentId) return;
      if (message.event !== "command_rejected" || message.module !== "remote_input") return;
      inputEnabledRef.current = false;
      releaseHeldInput();
      setRemoteControl(false); setControlAgentId(null);
      setInputError(typeof message.error === "string" ? message.error : "Remote input was rejected. Check this device’s module permissions.");
    };
    window.addEventListener("vantyr-ws-event", onServerEvent);
    return () => window.removeEventListener("vantyr-ws-event", onServerEvent);
  }, [agentId, releaseHeldInput]);

  const sendText = useCallback((text: string) => {
    if (!inputEnabledRef.current) return false;
    try { remoteTextChunks(text).forEach(chunk => ctrl({ type: "TypeText", text: chunk })); setInputError(""); return true; }
    catch (error) { setInputError((error as Error).message); return false; }
  }, [ctrl]);
  useEffect(() => {
    cursor.current = null; setCursorPreview(null); setZoom(1); setPan({ x: 0, y: 0 }); setInputError("");
  }, [agentId, monitorIndex]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => containerRef.current?.style.setProperty("--remote-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
    update(); viewport?.addEventListener("resize", update);
    return () => viewport?.removeEventListener("resize", update);
  }, []);

  useLayoutEffect(() => {
    const img = imgRef.current, marker = cursorMarker.current, overlay = overlayRef.current;
    if (!img || !marker || !overlay || !cursorPreview) return;
    const point = cursorLocation(img.getBoundingClientRect(), img.naturalWidth, img.naturalHeight, cursorPreview);
    if (!point) { marker.style.display = "none"; return; }
    const bounds = overlay.getBoundingClientRect();
    marker.style.display = "block"; marker.style.left = `${point.x - bounds.left}px`; marker.style.top = `${point.y - bounds.top}px`;
  }, [cursorPreview, zoom, pan, touchMode, fullscreen, pseudoFs, streamAspectRatio]);

  const beginTouch = (event: React.PointerEvent<HTMLDivElement>) => {
    if (gesture.current || (!inputEnabledRef.current && touchAction !== "pan")) return;
    const img = imgRef.current;
    if (!img && touchAction !== "pan") return;
    const client = { x: event.clientX, y: event.clientY };
    const current = cursor.current ?? { x: (img?.naturalWidth ?? 0) / 2, y: (img?.naturalHeight ?? 0) / 2 };
    const point = touchAction === "pan" ? current : touchPoint(touchMode, img!.getBoundingClientRect(), img!.naturalWidth, img!.naturalHeight, client, current, { x: 0, y: 0 });
    if (!point) return;
    event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { id: event.pointerId, start: client, last: client, point, moved: false, scroll: { x: 0, y: 0 }, action: touchAction };
    cursor.current = point; setCursorPreview(point);
    if (touchAction === "drag") { heldInput.current.buttonDown("left", point); ctrl({ type: "MouseDown", ...point, button: "left" }); }
  };
  const moveTouch = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = gesture.current;
    if (!state || state.id !== event.pointerId) return;
    event.preventDefault();
    const client = { x: event.clientX, y: event.clientY }, delta = { x: client.x - state.last.x, y: client.y - state.last.y };
    state.last = client;
    if (Math.hypot(client.x - state.start.x, client.y - state.start.y) > 8) state.moved = true;
    if (state.action === "pan") {
      const bounds = event.currentTarget.getBoundingClientRect();
      setPan(previous => clampPan({ x: previous.x + delta.x, y: previous.y + delta.y }, bounds.width, bounds.height, zoom, imgRef.current?.naturalWidth, imgRef.current?.naturalHeight)); return;
    }
    if (!inputEnabledRef.current) return;
    if (state.action === "scroll") {
      state.scroll.x -= delta.x; state.scroll.y -= delta.y;
      const dx = Math.max(-10, Math.min(10, Math.trunc(state.scroll.x / 40))), dy = Math.max(-10, Math.min(10, Math.trunc(state.scroll.y / 40)));
      if (dx || dy) { ctrl({ type: "MouseScroll", delta_x: dx, delta_y: dy }); state.scroll.x -= dx * 40; state.scroll.y -= dy * 40; } return;
    }
    const img = imgRef.current;
    if (!img) return;
    const point = touchPoint(touchMode, img.getBoundingClientRect(), img.naturalWidth, img.naturalHeight, client, state.point, delta, state.action === "drag");
    if (!point) return;
    state.point = point; cursor.current = point; setCursorPreview(point); heldInput.current.move(point);
    if (touchMode === "trackpad" || state.action === "drag") ctrl({ type: "MouseMove", ...point });
  };
  const endTouch = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = gesture.current;
    if (!state || state.id !== event.pointerId) return;
    if (event.clientX !== state.last.x || event.clientY !== state.last.y) moveTouch(event);
    if (Math.hypot(event.clientX - state.start.x, event.clientY - state.start.y) > 8) state.moved = true;
    gesture.current = null; event.preventDefault();
    if (state.action === "drag") { if (heldInput.current.buttonUp("left")) ctrl({ type: "MouseUp", ...state.point, button: "left" }, true); }
    else if (inputEnabledRef.current && !state.moved && (state.action === "tap" || state.action === "right")) {
      const button = state.action === "right" ? "right" : "left";
      ctrl({ type: "MouseDown", ...state.point, button }); ctrl({ type: "MouseUp", ...state.point, button });
    }
  };

  /** rAF-batched mouse move — fires at most once per animation frame. */
  const flushMouseMove = useCallback(() => {
    rafMoveRef.current = null;
    const pt = pendingMoveRef.current;
    if (!pt) return;
    pendingMoveRef.current = null;
    ctrl({ type: "MouseMove", x: pt.x, y: pt.y });
  }, [ctrl]);

  const handlePointerMove =
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === "touch" || touchAction === "pan") { moveTouch(e); return; }
      if (!inputEnabledRef.current || !e.isPrimary || !imgRef.current) return;
      const pt = pointerToImageCoords(imgRef.current, e.clientX, e.clientY, e.buttons !== 0);
      if (!pt) return;
      heldInput.current.move(pt);
      pendingMoveRef.current = pt;
      if (!rafMoveRef.current) {
        rafMoveRef.current = requestAnimationFrame(flushMouseMove);
      }
    };

  /** Pointer button → "left" | "middle" | "right". */
  const buttonName = (btn: number) =>
    btn === 2 ? "right" : btn === 1 ? "middle" : "left";

  const handlePointerDown =
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === "touch" || touchAction === "pan") { beginTouch(e); return; }
      if (!inputEnabledRef.current || !imgRef.current) return;
      const pt = pointerToImageCoords(imgRef.current, e.clientX, e.clientY);
      if (!pt) return;
      e.preventDefault();
      // `preventDefault` above stops the browser from focusing the overlay on
      // click, so do it explicitly — keyboard events only reach the overlay
      // while it holds focus, and clicking the screen is the natural way users
      // expect to "grab" keyboard input.
      (e.currentTarget as HTMLDivElement).focus();
      // Capture pointer so drag events keep firing even outside the element.
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      heldInput.current.buttonDown(buttonName(e.button), pt);
      ctrl({ type: "MouseDown", x: pt.x, y: pt.y, button: buttonName(e.button) });
    };

  const handlePointerUp =
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === "touch" || touchAction === "pan") { endTouch(e); return; }
      if (!inputEnabledRef.current || !imgRef.current) return;
      e.preventDefault();
      const pt = pointerToImageCoords(imgRef.current, e.clientX, e.clientY, true);
      if (!pt) return;
      if (heldInput.current.buttonUp(buttonName(e.button))) ctrl({ type: "MouseUp", x: pt.x, y: pt.y, button: buttonName(e.button) });
    };

  // Wheel must be a *native* non-passive listener: React's synthetic `onWheel`
  // is registered passively, so `preventDefault()` there is a no-op and the
  // dashboard page scrolls instead of the remote desktop. Attaching directly to
  // the overlay with { passive: false } lets us both forward the scroll to the
  // agent and stop the page from scrolling underneath it.
  useEffect(() => {
    const el = overlayRef.current;
    if (!el || !inputEnabled || touchAction === "pan") return;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      // Convert browser delta → scroll notches (1 notch ≈ one wheel click)
      const factor = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? 10 : 1 / 100;
      const dy = Math.round(e.deltaY * factor);
      const dx = Math.round(e.deltaX * factor);
      const cdx = Math.max(-10, Math.min(10, dx));
      const cdy = Math.max(-10, Math.min(10, dy));
      if (cdx === 0 && cdy === 0) return;
      ctrl({ type: "MouseScroll", delta_x: cdx, delta_y: cdy });
    };
    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
  }, [inputEnabled, touchAction, ctrl]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!inputEnabledRef.current || e.nativeEvent.isComposing) return;
      e.preventDefault();

      // ── Modifier keys: send KeyDown (hold) ──────────────────────────────
      if (MODIFIER_KEYS.has(e.key)) {
        if (heldInput.current.keyDown(e.key.toLowerCase())) ctrl({ type: "KeyDown", key: e.key.toLowerCase() });
        return;
      }

      // ── Ctrl+V: read local clipboard and paste to remote ────────────────
      if (e.ctrlKey && e.key === "v") {
        const generation = inputGeneration.current;
        (navigator.clipboard?.readText() ?? Promise.reject(new Error("Clipboard unavailable")))
          .then((text) => {
            if (generation === inputGeneration.current && text) sendText(text);
          })
          .catch(() => {
            // Clipboard access denied — fall back to forwarding the key combo
            if (generation === inputGeneration.current) ctrl({ type: "KeyChar", char: "v" });
          });
        return;
      }

      // ── Special keys: send KeyPress ──────────────────────────────────────
      const special = SPECIAL_KEY_MAP[e.key];
      if (special) {
        ctrl({ type: "KeyPress", key: special });
        return;
      }

      // ── Printable character ──────────────────────────────────────────────
      if (isPrintable(e.key)) {
        if (e.ctrlKey || e.altKey || e.metaKey) {
          // Modifier held — send as physical key so the OS combo fires correctly
          ctrl({ type: "KeyChar", char: e.key });
        } else {
          sendText(e.key);
        }
      }
    },
    [ctrl, sendText],
  );

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!inputEnabledRef.current) return;
      e.preventDefault();
      if (MODIFIER_KEYS.has(e.key)) {
        if (heldInput.current.keyUp(e.key.toLowerCase())) ctrl({ type: "KeyUp", key: e.key.toLowerCase() });
      }
    },
    [ctrl],
  );

  const handleSendNotification = () => {
    if (!notificationTitle.trim()) return;

    if (!inputEnabledRef.current) return;
    ctrl({ type: "Notify", title: notificationTitle, message: notificationMessage });

    setShowNotificationModal(false);
    setNotificationTitle("");
    setNotificationMessage("");
  };

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;

    const coarsePointer =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;
    const canNativeFs =
      typeof el.requestFullscreen === "function" &&
      document.fullscreenEnabled !== false &&
      !coarsePointer;

    if (canNativeFs) {
      if (!document.fullscreenElement) {
        void requestViewportFullscreen(el);
      } else {
        void exitViewportFullscreen();
      }
    } else {
      // iOS Safari / touch devices: the Fullscreen API can't target a <div>,
      // so fall back to a CSS fixed-overlay "maximize".
      setPseudoFs((v) => !v);
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const onFrameLoad = () => {
    if (!streamEnabled) return;
    setStreaming(true);
    setStreamEverLoaded(true);
    setStreamError(false);
    lastFrameAtMsRef.current = Date.now();
    // Capture natural dimensions from the first decoded MJPEG frame so the
    // container can lock to the remote screen's exact aspect ratio.
    const img = imgRef.current;
    if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
      setStreamAspectRatio(`${img.naturalWidth} / ${img.naturalHeight}`);
    }
  };
  const onFrameError = () => {
    setStreaming(false);
    setStreamError(true);
  };

  const remoteTools = <div className="screen-remote-tools" aria-label="Remote input tools">
    <label>Touch mode <select aria-label="Touch mode" value={touchMode} onChange={event => { releaseHeldInput(); setTouchMode(event.target.value as TouchMode); }}><option value="direct">Direct touch</option><option value="trackpad">Trackpad</option></select></label>
    <label>Touch action <select aria-label="Touch action" value={touchAction} onChange={event => { releaseHeldInput(); setTouchAction(event.target.value as TouchAction); }}>
      <option value="tap" disabled={!inputEnabled}>Tap / move pointer</option><option value="right" disabled={!inputEnabled}>Right click</option><option value="drag" disabled={!inputEnabled}>Drag</option><option value="scroll" disabled={!inputEnabled}>Scroll</option><option value="pan">Pan local view</option>
    </select></label>
    <button type="button" disabled={!inputEnabled} aria-expanded={keyboardOpen} onClick={() => { releaseHeldInput(); setKeyboardOpen(open => !open); }}>Software keyboard</button>
    {[ ["Tab", "tab"], ["Esc", "escape"], ["Enter", "enter"], ["←", "arrowleft"], ["↑", "arrowup"], ["↓", "arrowdown"], ["→", "arrowright"] ].map(([label, key]) => <button key={key} type="button" disabled={!inputEnabled} aria-label={`Remote ${key}`} onClick={() => ctrl({ type: "KeyPress", key })}>{label}</button>)}
    <button type="button" aria-label="Zoom in locally" disabled={!streamEnabled || zoom >= 4} onClick={() => { releaseHeldInput(); setZoom(value => Math.min(4, value + .5)); }}>Zoom +</button>
    <button type="button" aria-label="Zoom out locally" disabled={!streamEnabled || zoom <= 1} onClick={() => { releaseHeldInput(); setZoom(value => Math.max(1, value - .5)); setPan({ x: 0, y: 0 }); }}>Zoom −</button>
    <button type="button" disabled={!streamEnabled} onClick={toggleFullscreen}>{fullscreen || pseudoFs ? "Exit fullscreen" : "Maximize view"}</button>
    <button type="button" onClick={() => { releaseHeldInput(); setZoom(1); setPan({ x: 0, y: 0 }); }}>Fit view ({zoom}×)</button>
    {keyboardOpen && <RemoteSoftwareKeyboard ref={keyboardRef} enabled={inputEnabled} onText={sendText} />}
    <span className="screen-remote-help">Direct touch targets the screen; trackpad swipes move the pointer, taps click. Choose Drag or Scroll for finger gestures. Pan and zoom only change this view. Ctrl+Alt+Del secure attention is unavailable. Control is not exclusive; other operators may send input.</span>
    {inputError && <span role="alert">{inputError}</span>}
  </div>;

  if (embedded) {
    const showFrame = streamEnabled && streaming && !streamError;
    const isMaximized = fullscreen || pseudoFs;
    return (
      <div
        ref={containerRef}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) releaseHeldInput(); }}
        className={`screen-remote-panel${fullscreen || pseudoFs ? " screen-remote-maximized" : ""}`}
        style={{
          flex: "1 1 0",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r)",
          overflow: "hidden",
          ...(isMaximized
            ? { background: "#000", border: "none", borderRadius: 0 }
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
        <div className="screen-remote-stage" style={{ position: "relative", width: "100%", ...(isMaximized ? { flex: 1, minHeight: 0 } : streamEnabled || demoLive ? { aspectRatio: streamAspectRatio ?? "16 / 9", maxHeight: "min(58vh, 600px)" } : { height: 160 }), background: "#0a0b0d", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1.4px)", backgroundSize: "22px 22px" }} />
          {demoLive && <DemoScreen agentId={agentId} />}
          {streamEnabled && streamUrl && (
            <img
              key={`${agentId}-mjpeg-${mjpegStreamSession}`}
              ref={imgRef}
              src={streamUrl}
              alt="Agent screen"
              onLoad={onFrameLoad}
              onError={onFrameError}
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", display: showFrame ? "block" : "none" }}
            />
          )}

          {/* LIVE / OFFLINE badge */}
          <div style={{ position: "absolute", top: 14, left: 14, display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", borderRadius: 8, background: "rgba(0,0,0,0.5)", border: "1px solid var(--line-2)" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: online ? "var(--red)" : "var(--tx-3)" }} />
            <span style={{ fontSize: 11, fontWeight: 700, color: online ? "#fff" : "var(--tx-3)", letterSpacing: "0.08em" }}>{online ? "LIVE" : "OFFLINE"}</span>
          </div>
          <div style={{ position: "absolute", top: 14, right: 14, fontSize: 11, color: "var(--tx-3)", fontFamily: "var(--mono)" }}>
            {showFrame || demoLive ? "MJPEG · live" : online ? "connecting…" : "—"}
          </div>

          {!showFrame && !demoLive && (
            <div style={{ position: "relative", textAlign: "center", padding: 16 }}>
              <div style={{ width: 60, height: 60, borderRadius: 16, background: "var(--card-2)", border: "1px solid var(--line-2)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px", color: online ? "var(--gr)" : "var(--tx-3)" }}>
                <Monitor size={28} />
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--tx-2)" }}>
                {online ? (!screenAvailable ? "Live desktop unavailable" : streamError ? "Stream unavailable" : streamEnabled ? "Connecting to live desktop…" : "Live view paused") : "Agent offline"}
              </div>
              {!screenAvailable && (
                <div style={{ fontSize: 12, color: "var(--tx-3)", marginTop: 4 }}>
                  Screen capture is {capabilityStatus(agentInfo, "screen_capture") ?? "unsupported"} on this agent.
                </div>
              )}
              {placeholderTitle && (
                <div style={{ fontSize: 12, color: "var(--tx-3)", marginTop: 4, fontFamily: "var(--mono)" }}>{placeholderTitle}</div>
              )}
            </div>
          )}

          {streamEnabled && (inputEnabled || touchAction === "pan") && (
            <div
              ref={overlayRef}
              className="vantyr-remote-overlay"
              onPointerMove={handlePointerMove}
              onPointerDown={handlePointerDown}
              onPointerUp={handlePointerUp}
              onPointerCancel={releaseHeldInput}
              onLostPointerCapture={releasePointer}
              onBlur={releaseHeldInput}
              onKeyDown={handleKeyDown}
              onKeyUp={handleKeyUp}
              onContextMenu={(e) => e.preventDefault()}
              tabIndex={0}
              role="application"
              aria-label={inputEnabled ? "Remote control — click, drag, scroll and type to control the remote machine" : "Pan local screen view"}
            >{touchMode === "trackpad" && cursorPreview && <span ref={cursorMarker} className="remote-trackpad-cursor" aria-hidden="true" />}</div>
          )}
        </div>

        {remoteTools}
        {/* control bar — wraps on narrow viewports so the last button is never
            clipped off the right edge */}
        <div
          className="vtl-screen-controls"
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 9,
            padding: "12px 14px",
            borderTop: "1px solid var(--line)",
          }}
        >
          <button
            type="button"
            onClick={() => changeRemoteControl(!inputEnabled)}
            disabled={!remoteControlAllowed}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 14px",
              borderRadius: 10,
              border: "none",
              background: inputEnabled ? "var(--gr)" : "var(--card-2)",
              color: inputEnabled ? "#06251a" : "var(--tx-2)",
              fontSize: 12.5,
              fontWeight: 700,
              cursor: remoteControlAllowed ? "pointer" : "not-allowed",
              opacity: remoteControlAllowed ? 1 : 0.5,
            }}
          >
            <MousePointer2 size={15} /> {inputEnabled ? "Controlling" : "Take control"}
          </button>
          {audioAvailable && !blockedByRole && (
            <button
              type="button"
              onClick={() => { if (audioActive) stopAudio(); else void startAudio(); }}
              disabled={!online}
              title={audioActive ? "Mute desktop audio" : "Hear desktop audio"}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                padding: "8px 13px",
                borderRadius: 10,
                background: audioActive ? "var(--gr)" : "var(--card-2)",
                border: "1px solid var(--line-2)",
                color: audioActive ? "#06251a" : "var(--tx-2)",
                fontSize: 12.5,
                fontWeight: 600,
                cursor: online ? "pointer" : "not-allowed",
                opacity: online ? 1 : 0.5,
              }}
            >
              {audioActive ? <Volume2 size={15} /> : <VolumeX size={15} />} {audioActive ? "Audio on" : "Audio"}
            </button>
          )}
          <button
            type="button"
            onClick={toggleFullscreen}
            disabled={!streamEnabled}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "8px 13px",
              borderRadius: 10,
              background: "var(--card-2)",
              border: "1px solid var(--line-2)",
              color: "var(--tx-2)",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: streamEnabled ? "pointer" : "not-allowed",
              opacity: streamEnabled ? 1 : 0.5,
            }}
          >
            {isMaximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />} {isMaximized ? "Exit" : "Fullscreen"}
          </button>
          <select
            value={streamPreset}
            disabled={!streamEnabled}
            onChange={(e) => {
              const v = e.target.value as StreamPreset;
              if (v in STREAM_PRESET_TUNING) applyStreamPreset(v);
            }}
            aria-label="Stream quality"
            title="Stream quality"
            style={{
              padding: "8px 10px",
              borderRadius: 10,
              background: "var(--card-2)",
              border: "1px solid var(--line-2)",
              color: "var(--tx-2)",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: streamEnabled ? "pointer" : "not-allowed",
              opacity: streamEnabled ? 1 : 0.5,
              fontFamily: "var(--font)",
            }}
          >
            {STREAM_PRESET_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {showMonitorPicker && (
            <select
              value={selectedMonitorIndex}
              disabled={!streamEnabled}
              onChange={(e) => applyMonitor(Number(e.target.value))}
              aria-label="Monitor"
              title="Monitor"
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                background: "var(--card-2)",
                border: "1px solid var(--line-2)",
                color: "var(--tx-2)",
                fontSize: 12.5,
                fontWeight: 600,
                cursor: streamEnabled ? "pointer" : "not-allowed",
                opacity: streamEnabled ? 1 : 0.5,
                fontFamily: "var(--font)",
                maxWidth: 200,
              }}
            >
              {monitors.map((m, i) => (
                <option key={i} value={i}>
                  {monitorLabel(m, i)}
                </option>
              ))}
            </select>
          )}
          {placeholderSub && (
            <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--tx-3)", fontFamily: "var(--mono)" }}>{placeholderSub}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="vantyr-screen-tab">
      <Container
        header={
          <Header
            variant="h2"
            actions={
              <div className="vantyr-screen-header-actions">
                <div className="vantyr-screen-header__status">
                  <StreamStatus
                    state={
                      blockedByRole
                        ? "blocked"
                        : streaming
                          ? "streaming"
                          : streamEnabled
                            ? streamError
                              ? "stalled"
                              : streamEverLoaded
                                ? isStalled
                                  ? "stalled"
                                  : "waiting"
                                : "starting"
                            : "waiting"
                    }
                  />
                </div>
                <div className="vantyr-screen-header__preset">
                  <FormField label="Stream quality" stretch>
                    <Select
                      disabled={blockedByRole || !streamEnabled}
                      selectedOption={
                        STREAM_PRESET_OPTIONS.find((o) => o.value === streamPreset) ?? STREAM_PRESET_OPTIONS[1]
                      }
                      onChange={({ detail }) => {
                        const v = detail.selectedOption?.value as StreamPreset | undefined;
                        // Guard against the option list drifting from StreamPreset
                        // again (previously "ultra" was silently dropped here).
                        if (v && v in STREAM_PRESET_TUNING) {
                          applyStreamPreset(v);
                        }
                      }}
                      options={STREAM_PRESET_OPTIONS.map((o) => ({
                        label: o.label,
                        value: o.value,
                        description: o.description,
                      }))}
                    />
                  </FormField>
                </div>
                {showMonitorPicker && (
                  <div className="vantyr-screen-header__preset">
                    <FormField label="Monitor" stretch>
                      <Select
                        disabled={blockedByRole || !streamEnabled}
                        selectedOption={{
                          label: monitorLabel(
                            monitors[selectedMonitorIndex] ?? monitors[0],
                            selectedMonitorIndex,
                          ),
                          value: String(selectedMonitorIndex),
                        }}
                        onChange={({ detail }) => {
                          const v = detail.selectedOption?.value;
                          if (v != null) applyMonitor(Number(v));
                        }}
                        options={monitors.map((m, i) => ({
                          label: monitorLabel(m, i),
                          value: String(i),
                        }))}
                      />
                    </FormField>
                  </div>
                )}
                <div className="vantyr-screen-header__toggle">
                  <Toggle
                    checked={inputEnabled}
                    disabled={blockedByRole || !remoteControlAllowed}
                    onChange={({ detail }) => changeRemoteControl(detail.checked)}
                  >
                    Remote control
                  </Toggle>
                </div>
                <Button
                  iconName="notification"
                  disabled={!inputEnabled}
                  ariaLabel="Send notification"
                  onClick={() => setShowNotificationModal(true)}
                >
                  <span className="vantyr-screen-header__btn-text">Send notification</span>
                </Button>
                <Button
                  iconName={fullscreen ? "close" : "expand"}
                  disabled={blockedByRole || !streamEnabled}
                  ariaLabel={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                  onClick={toggleFullscreen}
                >
                  <span className="vantyr-screen-header__btn-text">{fullscreen ? "Exit" : "Fullscreen"}</span>
                </Button>
              </div>
            }
          >
            Screen Viewer
          </Header>
        }
      >
        {blockedByRole ? (
          <Box margin={{ bottom: "m" }}>
            <Alert type="info" header="Operator role required">
              Live screen viewing requires the <strong>operator</strong> or <strong>admin</strong> role. Viewers can still
              use keys, windows, URLs, and other telemetry tabs.
            </Alert>
          </Box>
        ) : null}
        {!screenAvailable ? (
          <Box margin={{ bottom: "m" }}>
            <Alert type="info" header="Screen capture unavailable">
              This agent reports screen capture as <code>{capabilityStatus(agentInfo, "screen_capture") ?? "unsupported"}</code>.
            </Alert>
          </Box>
        ) : null}
        {screenAvailable && !remoteInputAvailable ? (
          <Box margin={{ bottom: "m" }}>
            <Alert type="info" header="Remote input unavailable">
              Viewing can still work, but this agent reports remote input as <code>{capabilityStatus(agentInfo, "remote_input") ?? "unsupported"}</code>.
            </Alert>
          </Box>
        ) : null}
        <div
          ref={containerRef}
          onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) releaseHeldInput(); }}
          className={`screen-remote-panel vantyr-screen-viewer${fullscreen ? " vantyr-screen-viewer-fullscreen screen-remote-maximized" : ""}${pseudoFs ? " screen-remote-maximized" : ""}`}
          style={{ position: "relative", ...(pseudoFs ? { position: "fixed", inset: 0, zIndex: 3000, display: "flex", flexDirection: "column", width: "100vw" } as const : {}) }}
        >
          <div className="vantyr-screen-frame screen-remote-stage">
            <img
              key={
                streamEnabled && mjpegStreamSession
                  ? `${agentId}-mjpeg-${mjpegStreamSession}`
                  : `${agentId}-mjpeg-off`
              }
              ref={imgRef}
              src={streamEnabled ? streamUrl : ""}
              alt="Agent screen"
              className="vantyr-screen-image"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
              onLoad={() => {
                if (!streamEnabled) return;
        setStreaming(true);
        setStreamEverLoaded(true);
        setStreamError(false);
        lastFrameAtMsRef.current = Date.now();
      }}
              onError={() => {
                setStreaming(false);
                setStreamError(true);
              }}
            />
            {streamEnabled && (inputEnabled || touchAction === "pan") && (
              <div
                ref={overlayRef}
                className="vantyr-remote-overlay"
                onPointerMove={handlePointerMove}
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUp}
              onPointerCancel={releaseHeldInput}
              onLostPointerCapture={releasePointer}
              onBlur={releaseHeldInput}
                onKeyDown={handleKeyDown}
                onKeyUp={handleKeyUp}
                onContextMenu={(e) => e.preventDefault()}
                tabIndex={0}
                role="application"
                aria-label={inputEnabled ? "Remote control — click, drag, scroll and type to control the remote machine" : "Pan local screen view"}
              >{touchMode === "trackpad" && cursorPreview && <span ref={cursorMarker} className="remote-trackpad-cursor" aria-hidden="true" />}</div>
            )}
          </div>
          {remoteTools}
        </div>

        {!streaming && streamEnabled && (
          <Box textAlign="center" padding="xxl">
            <Box variant="p" color="text-body-secondary">
              {streamError
                ? "Screen stream failed to load. The agent may be offline or the server rejected the stream request."
                : "Starting screen stream…"}
            </Box>
            {streamError && (
              <Box padding={{ top: "s" }}>
                <Button
                  onClick={() => {
                    // Restart MJPEG session to force a new request.
                    setMjpegStreamSession(crypto.randomUUID());
                  }}
                >
                  Retry
                </Button>
              </Box>
            )}
          </Box>
        )}
        {streaming && streamEnabled && isStalled && (
          <Box margin={{ top: "m" }}>
            <Alert type="warning" header="Stream appears stalled">
              No new frames have been received recently. This can happen if the agent paused capture, the network is unstable,
              or a proxy dropped the connection.
              <Box padding={{ top: "s" }}>
                <Button onClick={() => setMjpegStreamSession(crypto.randomUUID())}>Reconnect</Button>
              </Box>
            </Alert>
          </Box>
        )}
      </Container>
      </div>

      <Modal
        visible={showNotificationModal}
        onDismiss={() => setShowNotificationModal(false)}
        header="Send notification"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setShowNotificationModal(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleSendNotification}
                disabled={!inputEnabled || !notificationTitle.trim()}
              >
                Send
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="l">
          <FormField label="Title" constraintText="Required">
            <Input
              value={notificationTitle}
              onChange={({ detail }) => setNotificationTitle(detail.value)}
              placeholder="Notification title"
            />
          </FormField>
          <FormField label="Message">
            <Input
              value={notificationMessage}
              onChange={({ detail }) => setNotificationMessage(detail.value)}
              placeholder="Optional message"
            />
          </FormField>
        </SpaceBetween>
      </Modal>
    </>
  );
}
