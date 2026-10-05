import { useMjpegFrames, type DisplayedRemoteFrame } from "../../hooks/useMjpegFrames";
import type { CaptureGeometry } from "../../lib/remoteFrame";
import { useRemoteControlLease } from "../../hooks/useRemoteControlLease";
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
import { useCallback, useState, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { mjpegStreamUrl, notifyMjpegViewerLeft, apiUrl, type MjpegStreamTuning } from "../../lib/api";
import { StreamStatus } from "../common/StatusIndicator";
import type { AgentInfo, DashboardRole, MonitorInfo } from "../../lib/types";
import { capabilityAvailable, capabilityFullySupported, capabilityStatus } from "../../lib/agentCapabilities";
import { isDemoMode } from "../../demo/mode";
import { DemoScreen } from "../../demo/fakeScreen";
import { remoteImagePoint } from "../../lib/remotePointer";
import { RemoteToolsSheet, RemoteToolGroup } from "./RemoteToolsSheet";
import { RemoteClipboardPanel } from "./RemoteClipboardPanel";
import { RemoteSoftwareKeyboard, type RemoteKeyboardHandle } from "./RemoteSoftwareKeyboard";
import { cursorLocation, clampPan, remoteTextChunks, touchPoint, type Point, type TouchMode, type TouchAction } from "./remoteTouch";
import { RemoteHeldInput } from "../../lib/remoteHeldInput";

function controlGeometryAvailable(geometry: CaptureGeometry | null | undefined): geometry is CaptureGeometry {
  return Boolean(geometry?.desktop && typeof geometry.monitor_index === "number" && geometry.monitor_index >= 0 && geometry.monitor_index < 64);
}

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
  { label: "Ultra", description: "~30 fps — lowest latency, high CPU + network usage.",     value: "ultra" },
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
  img: { getBoundingClientRect: () => DOMRect; naturalWidth: number; naturalHeight: number },
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
  const [fullscreen, setFullscreen] = useState(false);
  /** CSS-overlay "maximize" for touch/iOS where the Fullscreen API can't target a <div>. */
  const [pseudoFs, setPseudoFs] = useState(false);
  const [showNotificationModal, setShowNotificationModal] = useState(false);
  const [notificationTitle, setNotificationTitle] = useState("");
  const [notificationMessage, setNotificationMessage] = useState("");
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const beforeDisplayRef = useRef<(frame: DisplayedRemoteFrame | null) => void>(() => {});
  const onBeforeDisplay = useCallback((frame: DisplayedRemoteFrame | null) => beforeDisplayRef.current(frame), []);
  const lastPresentedIdentity = useRef<string | null>(null);
  const inputContext = useRef<{agentId: string; token: string | null; stamp: Pick<CaptureGeometry, "capture_id" | "geometry_revision"> | null} | null>(null);
  const [isStalled, setIsStalled] = useState(false);
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
  const inputEnabledRef = useRef(false);
  const keyboardRef = useRef<RemoteKeyboardHandle>(null);
  const [touchMode, setTouchMode] = useState<TouchMode>("direct");
  const [touchAction, setTouchAction] = useState<TouchAction>("tap");
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsTrigger = useRef<HTMLButtonElement>(null);
  const [clipboardOpen, setClipboardOpen] = useState(false);
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
  const sessionAgent = useRef(agentId);
  const [streamPreset, setStreamPreset] = useState<StreamPreset>(() => loadStreamPreset());
  /** Explicit monitor selection (0-based). `null` = let the agent pick its primary. */
  const [monitorIndex, setMonitorIndex] = useState<number | null>(null);

  const canOperate = dashboardRole === "operator" || dashboardRole === "admin";
  // Viewers may watch; control, keyboard and desktop audio stay operator-only.
  const blockedByRole = !canOperate && dashboardRole !== "viewer";
  const screenAvailable = capabilityAvailable(agentInfo, "screen_capture");
  const audioAvailable = capabilityAvailable(agentInfo, "audio_capture");
  const remoteInputAvailable = capabilityFullySupported(agentInfo, "remote_input") && capabilityStatus(agentInfo, "remote_input")?.toLowerCase() === "supported";
  const streamEnabled = streamActive && screenAvailable;
  const streamTuning = STREAM_PRESET_TUNING[streamPreset];
  const streamUrl = useMemo(
    () => streamEnabled && sessionAgent.current === agentId && mjpegStreamSession
      ? mjpegStreamUrl(agentId, mjpegStreamSession, streamTuning, monitorIndex ?? undefined) : "",
    [streamEnabled, agentId, mjpegStreamSession, streamTuning, monitorIndex],
  );
  const mjpeg = useMjpegFrames(streamUrl, !isDemoMode && streamEnabled && online && !blockedByRole, canvasRef, {
    beforeDisplay: onBeforeDisplay,
    stopped: () => { if (mjpegStreamSession) notifyMjpegViewerLeft(agentId, mjpegStreamSession); },
  });
  const { getDisplayed, stop: stopMjpeg } = mjpeg;
  const surface = useCallback(() => {
    if (isDemoMode) return imgRef.current;
    const element = canvasRef.current, frame = getDisplayed();
    return element && frame ? { getBoundingClientRect: () => element.getBoundingClientRect(), naturalWidth: frame.width, naturalHeight: frame.height } : null;
  }, [getDisplayed]);
  // Server control requires a verified physical desktop rectangle. Missing
  // physical metadata keeps the entire real stream view-only.
  const verifiedFrame = isDemoMode || controlGeometryAvailable(mjpeg.frame?.geometry);
  const remoteControlAllowed = online && streamEnabled && canOperate && remoteInputAvailable && verifiedFrame && !isStalled;
  const getCaptureStamp = useCallback(() => {
    const g = getDisplayed()?.geometry;
    return controlGeometryAvailable(g) ? { capture_id: g.capture_id, geometry_revision: g.geometry_revision } : null;
  }, [getDisplayed]);
  const lease = useRemoteControlLease(agentId, remoteControlAllowed, sendWsMessage, { captureSession: mjpegStreamSession || null, getCaptureStamp: isDemoMode ? undefined : getCaptureStamp });
  const inputEnabled = remoteControlAllowed && lease.token !== null;
  const releaseLease = lease.release;
  const reconnectStream = () => { abortMjpegRef.current(); releaseLease(); setMjpegStreamSession(crypto.randomUUID()); };
  const pointerEnabled = inputEnabled && (isDemoMode || controlGeometryAvailable(mjpeg.frame?.geometry));
  const pointerAllowedNow = () => inputEnabledRef.current && (isDemoMode || Boolean(getDisplayed()?.geometry?.desktop));
  inputEnabledRef.current = inputEnabled;

  const changeRemoteControl = (enabled: boolean) => {
    if (enabled) { setInputError(""); lease.acquire(); } else lease.release();
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
  useEffect(() => {
    if (!streamEnabled || isDemoMode) {
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
    let wasHidden = document.hidden;
    const onVisibility = () => {
      if (document.hidden) { wasHidden = true; return; }
      if (wasHidden) {
        wasHidden = false;
        setMjpegStreamSession((prev) => {
          if (isDemoMode && prev) notifyMjpegViewerLeft(agentId, prev);
          return crypto.randomUUID();
        });
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [agentId, streamEnabled]);

  useEffect(() => {
    if (!streamEnabled || !online) { setMjpegStreamSession(""); return; }
    sessionAgent.current = agentId;
    setMjpegStreamSession(crypto.randomUUID());
  }, [agentId, streamEnabled, online]);

  useEffect(() => {
    // Reset status when stream toggles or agent changes.
    setStreaming(false);
    setStreamEverLoaded(false);
    setStreamError(false);
    setStreamAspectRatio(null);
    setIsStalled(false);
    lastFrameAtMsRef.current = null;
  }, [agentId, streamEnabled, mjpegStreamSession]);

  // Monitor picker (only shown when the agent reports more than one monitor).
  const monitors = agentInfo?.monitors ?? [];
  const showMonitorPicker = streamEnabled && monitors.length > 1;
  const primaryMonitorIndex = Math.max(0, monitors.findIndex((m) => m.primary));
  const selectedMonitorIndex = monitorIndex ?? primaryMonitorIndex;

  useEffect(() => {
    if (isDemoMode) return;
    setStreaming(Boolean(mjpeg.frame));
    setStreamError(Boolean(mjpeg.error));
    if (mjpeg.frame) {
      setStreamEverLoaded(true);
      lastFrameAtMsRef.current = Date.now();
      setStreamAspectRatio(`${mjpeg.frame.width} / ${mjpeg.frame.height}`);
    }
  }, [mjpeg.frame, mjpeg.error]);

  const applyStreamPreset = useCallback(
    (next: StreamPreset) => {
      abortMjpegRef.current();
      releaseLease();
      setStreamPreset(next);
      saveStreamPreset(next);

      if (!streamEnabled) return;

      // Rotate MJPEG session so the GET request picks up new tuning query params immediately.
      setMjpegStreamSession((prev) => {
        if (isDemoMode && prev) notifyMjpegViewerLeft(agentId, prev);
        return crypto.randomUUID();
      });
    },
    [agentId, streamEnabled, releaseLease],
  );

  const applyMonitor = useCallback(
    (next: number) => {
      abortMjpegRef.current();
      releaseLease();
      setMonitorIndex(next);

      if (!streamEnabled) return;

      // Rotate the MJPEG session so the new `?monitor=` param starts a fresh
      // capture immediately. The server rejects a reused session id, so we must
      // mint a new one (same pattern as the stream-quality change above).
      setMjpegStreamSession((prev) => {
        if (isDemoMode && prev) notifyMjpegViewerLeft(agentId, prev);
        return crypto.randomUUID();
      });
    },
    [agentId, streamEnabled, releaseLease],
  );


  // Drop any monitor selection when switching agents — indices aren't comparable
  // across machines, so fall back to the new agent's primary.
  useEffect(() => {
    setMonitorIndex(null);
  }, [agentId]);

  /** Drop MJPEG and notify the server immediately so the agent gets `stop_capture` without waiting on the browser. */
  const abortMjpeg = useCallback(() => {
    stopMjpeg();
    const el = imgRef.current;
    if (el) {
      el.removeAttribute("src");
      el.src = "";
      el.removeAttribute("srcset");
    }
    setStreaming(false);
    if (isDemoMode && mjpegStreamSession) {
      notifyMjpegViewerLeft(agentId, mjpegStreamSession);
    }
  }, [agentId, mjpegStreamSession, stopMjpeg]);

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
      if (e.key === "Escape" && !e.defaultPrevented) setPseudoFs(false);
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
      if (release && (cmd.type === "KeyUp" || cmd.type === "MouseUp")) {
        const context = inputContext.current;
        if (context) sendWsMessage({ type: "control", agent_id: context.agentId, lease_token: context.token, cmd: { ...cmd, ...context.stamp } });
        return;
      }
      if (!inputEnabledRef.current) return;
      const geometry = getDisplayed()?.geometry;
      if (!isDemoMode && !controlGeometryAvailable(geometry)) return;
      const stamp = !isDemoMode && geometry ? { capture_id: geometry.capture_id, geometry_revision: geometry.geometry_revision } : null;
      inputContext.current = { agentId, token: lease.token, stamp };
      sendWsMessage({ type: "control", agent_id: agentId, lease_token: lease.token, cmd: { ...cmd, ...stamp } });
    },
    [agentId, sendWsMessage, lease.token, getDisplayed],
  );

  const releaseHeldInput = useCallback(() => {
    gesture.current = null;
    keyboardRef.current?.cancel();
    if (rafMoveRef.current != null) cancelAnimationFrame(rafMoveRef.current);
    rafMoveRef.current = null;
    pendingMoveRef.current = null;
    heldInput.current.releaseAll().forEach(cmd => ctrl(cmd, true));
    inputContext.current = null;
  }, [ctrl]);
  useLayoutEffect(() => {
    beforeDisplayRef.current = frame => {
      const g = frame?.geometry;
      const identity = g ? `${g.capture_id}:${g.geometry_revision}` : null;
      if (lastPresentedIdentity.current !== identity || !frame || !controlGeometryAvailable(g)) {
        releaseHeldInput();
        cursor.current = null; setCursorPreview(null);
      }
      if (!isDemoMode && !controlGeometryAvailable(g)) inputEnabledRef.current = false;
      lastPresentedIdentity.current = identity;
    };
  }, [releaseHeldInput]);
  const releasePointer = useCallback(() => {
    gesture.current = null;
    if (rafMoveRef.current !== null) cancelAnimationFrame(rafMoveRef.current);
    rafMoveRef.current = null; pendingMoveRef.current = null;
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
      releaseLease();
      setInputError(typeof message.error === "string" ? message.error : "Remote input rejected. Check module permissions.");
    };
    window.addEventListener("vantyr-ws-event", onServerEvent);
    return () => window.removeEventListener("vantyr-ws-event", onServerEvent);
  }, [agentId, releaseHeldInput, releaseLease]);

  useEffect(() => {
    const expire = () => { inputEnabledRef.current = false; releaseHeldInput(); releaseLease(); setClipboardOpen(false); };
    const storage = (event: StorageEvent) => { if (event.key === null || event.key === "vantyr-server-settings") expire(); };
    window.addEventListener("vantyr-session-expired", expire); window.addEventListener("storage", storage);
    return () => { window.removeEventListener("vantyr-session-expired", expire); window.removeEventListener("storage", storage); };
  }, [releaseHeldInput, releaseLease]);

  const sendText = useCallback((text: string) => {
    if (!inputEnabledRef.current) return false;
    try { remoteTextChunks(text).forEach(chunk => ctrl({ type: "TypeText", text: chunk })); setInputError(""); return true; }
    catch (error) { setInputError((error as Error).message); return false; }
  }, [ctrl]);
  useEffect(() => {
    cursor.current = null; setCursorPreview(null); setZoom(1); setPan({ x: 0, y: 0 }); setInputError(""); setClipboardOpen(false); setToolsOpen(false);
  }, [agentId, monitorIndex]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => containerRef.current?.style.setProperty("--remote-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
    update(); viewport?.addEventListener("resize", update); window.addEventListener("resize", update);
    return () => { viewport?.removeEventListener("resize", update); window.removeEventListener("resize", update); };
  }, []);

  // Rotation, browser chrome and software-keyboard changes can shrink the stage.
  // Cancel a gesture before reclamping the local view to the new dimensions.
  useEffect(() => {
    const stage = containerRef.current?.querySelector<HTMLElement>(".screen-remote-stage, .vantyr-screen-frame");
    if (!stage) return;
    const resize = () => {
      releasePointer();
      const bounds = stage.getBoundingClientRect(), img = surface();
      setPan(previous => clampPan(previous, bounds.width, bounds.height, zoom, img?.naturalWidth, img?.naturalHeight));
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    observer?.observe(stage); window.addEventListener("resize", resize); window.visualViewport?.addEventListener("resize", resize);
    return () => { observer?.disconnect(); window.removeEventListener("resize", resize); window.visualViewport?.removeEventListener("resize", resize); };
  }, [zoom, surface, releasePointer]);

  useLayoutEffect(() => {
    const img = surface(), marker = cursorMarker.current, overlay = overlayRef.current;
    if (!img || !marker || !overlay || !cursorPreview) return;
    const point = cursorLocation(img.getBoundingClientRect(), img.naturalWidth, img.naturalHeight, cursorPreview);
    if (!point) { marker.style.display = "none"; return; }
    const bounds = overlay.getBoundingClientRect();
    marker.style.display = "block"; marker.style.left = `${point.x - bounds.left}px`; marker.style.top = `${point.y - bounds.top}px`;
  }, [cursorPreview, zoom, pan, touchMode, fullscreen, pseudoFs, streamAspectRatio, surface]);

  const beginTouch = (event: React.PointerEvent<HTMLDivElement>) => {
    if (gesture.current || (!inputEnabledRef.current && touchAction !== "pan") || (["tap", "right", "drag"].includes(touchAction) && !pointerAllowedNow())) return;
    const img = surface();
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
      setPan(previous => clampPan({ x: previous.x + delta.x, y: previous.y + delta.y }, bounds.width, bounds.height, zoom, surface()?.naturalWidth, surface()?.naturalHeight)); return;
    }
    if (!inputEnabledRef.current) return;
    if (state.action === "scroll") {
      state.scroll.x -= delta.x; state.scroll.y -= delta.y;
      const dx = Math.max(-10, Math.min(10, Math.trunc(state.scroll.x / 40))), dy = Math.max(-10, Math.min(10, Math.trunc(state.scroll.y / 40)));
      if (dx || dy) { ctrl({ type: "MouseScroll", delta_x: dx, delta_y: dy }); state.scroll.x -= dx * 40; state.scroll.y -= dy * 40; } return;
    }
    const img = surface();
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
      if (!pointerAllowedNow() || !e.isPrimary || !surface()) return;
      const pt = pointerToImageCoords(surface()!, e.clientX, e.clientY, e.buttons !== 0);
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
      if (!pointerAllowedNow() || !surface()) return;
      const pt = pointerToImageCoords(surface()!, e.clientX, e.clientY);
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
      if (!pointerAllowedNow() || !surface()) return;
      e.preventDefault();
      const pt = pointerToImageCoords(surface()!, e.clientX, e.clientY, true);
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
    let scrollX = 0, scrollY = 0;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      // Convert browser delta → scroll notches (1 notch ≈ one wheel click)
      const factor = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? 10 : 1 / 100;
      scrollY += e.deltaY * factor; scrollX += e.deltaX * factor;
      const dy = Math.trunc(scrollY);
      const dx = Math.trunc(scrollX);
      const cdx = Math.max(-10, Math.min(10, dx));
      const cdy = Math.max(-10, Math.min(10, dy));
      if (cdx === 0 && cdy === 0) return;
      scrollX -= cdx; scrollY -= cdy;
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

    if (pseudoFs) { setPseudoFs(false); return; }
    releaseHeldInput();
    if (canNativeFs) {
      if (!document.fullscreenElement) {
        void requestViewportFullscreen(el).catch(() => setPseudoFs(true));
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
    const img = surface();
    if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
      setStreamAspectRatio(`${img.naturalWidth} / ${img.naturalHeight}`);
    }
  };
  const onFrameError = () => {
    setStreaming(false);
    setStreamError(true);
  };

  useEffect(() => {
    if (!streamActive || !online) { setToolsOpen(false); setClipboardOpen(false); setKeyboardOpen(false); setShowNotificationModal(false); }
  }, [streamActive, online]);

  const closeTools = () => { setToolsOpen(false); setClipboardOpen(false); };
  const connectionNote = blockedByRole ? "Sign-in access required." : !online ? "Agent offline." : !screenAvailable ? "Live desktop unavailable." : !streamEnabled ? "Live view paused." : !isDemoMode && mjpeg.error ? "Live view disconnected. Reconnect in More tools." : !isDemoMode && !mjpeg.frame ? "Connecting to live view…" : isStalled ? "Live view stalled. Reconnect in More tools." : !canOperate ? "View only. Operator access needed." : !isDemoMode && !verifiedFrame ? "View only. Display not verified." : !remoteInputAvailable ? "View only. Authorize remote input on the device." : "";
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
          <label>Stream quality <select aria-label="Stream quality" disabled={!streamEnabled || blockedByRole} value={streamPreset} onChange={event => { applyStreamPreset(event.target.value as StreamPreset); closeTools(); }}>{STREAM_PRESET_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          {showMonitorPicker && <label>Monitor <select aria-label="Monitor" disabled={!streamEnabled || blockedByRole} value={selectedMonitorIndex} onChange={event => { applyMonitor(Number(event.target.value)); closeTools(); }}>{monitors.map((monitor, index) => <option key={index} value={index}>{monitorLabel(monitor, index)}</option>)}</select></label>}
        </div>
        {((!isDemoMode && mjpeg.error) || isStalled) && online && streamEnabled && !blockedByRole && <button type="button" onClick={() => { reconnectStream(); closeTools(); }}>Reconnect live view</button>}
      </RemoteToolGroup>
      <RemoteToolGroup title="Audio & notification">
        <div className="remote-tool-buttons">
          {audioAvailable && canOperate && <button type="button" disabled={!online || isDemoMode} aria-pressed={audioActive} onClick={() => { if (audioActive) stopAudio(); else void startAudio(); }}>{audioActive ? <Volume2 size={17} aria-hidden="true" /> : <VolumeX size={17} aria-hidden="true" />}{audioActive ? "Mute desktop audio" : "Hear desktop audio"}</button>}
          <button type="button" disabled={!inputEnabled} onClick={() => { releaseHeldInput(); closeTools(); setShowNotificationModal(true); }}>Send notification</button>
        </div>
        {isDemoMode && <p className="remote-tool-hint">No audio in demo.</p>}
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
        <div className="screen-remote-stage" style={{ position: "relative", width: "100%", ...(isMaximized ? { flex: 1, minHeight: 0 } : streamEnabled || demoLive ? { aspectRatio: streamAspectRatio ?? "16 / 9", maxHeight: "min(58vh, 600px)" } : { height: 160 }), background: "#0a0b0d", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1.4px)", backgroundSize: "22px 22px" }} />
          {demoLive && <DemoScreen agentId={agentId} />}
          {/* The demo placeholder frame still drives load state and pointer mapping, but stays invisible over the mock desktop. */}
          {isDemoMode && streamEnabled && streamUrl && (
            <img
              key={`${agentId}-mjpeg-${mjpegStreamSession}`}
              ref={imgRef}
              src={streamUrl}
              alt="Agent screen"
              onLoad={onFrameLoad}
              onError={onFrameError}
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", display: showFrame ? "block" : "none", ...(demoLive ? { opacity: 0 } : {}) }}
            />
          )}

          {!isDemoMode && streamEnabled && streamUrl && <canvas ref={canvasRef} role="img" aria-label="Agent screen" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", display: showFrame ? "block" : "none" }} />}

          {/* LIVE / OFFLINE badge */}
          <div className="absolute top-3.5 left-3.5 flex items-center gap-[7px] rounded-lg border border-white/10 bg-black/50 px-2.5 py-[5px]">
            <span className={`size-[7px] rounded-full ${online ? "bg-destructive" : "bg-muted-foreground"}`} />
            <span className={`text-[11px] font-bold tracking-[0.08em] ${online ? "text-white" : "text-muted-foreground"}`}>{online ? "LIVE" : "OFFLINE"}</span>
          </div>
          <div className="absolute top-3.5 right-3.5 font-mono text-[11px] text-muted-foreground">
            {showFrame || demoLive ? "MJPEG · live" : online ? "connecting…" : "—"}
          </div>

          {!showFrame && !demoLive && (
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
              aria-label={inputEnabled ? pointerEnabled ? "Remote control — click, drag, scroll and type to control the remote machine" : "Remote keyboard and scroll — pointer input unavailable" : "Pan local screen view"}
            >{touchMode === "trackpad" && cursorPreview && <span ref={cursorMarker} className="remote-trackpad-cursor" aria-hidden="true" />}</div>
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
            {isDemoMode ? (
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
            ) : <canvas ref={canvasRef} role="img" aria-label="Agent screen" className="vantyr-screen-image" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, width: "100%", height: "100%", objectFit: "contain", display: streaming && !streamError ? "block" : "none" }} />}
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
                aria-label={inputEnabled ? pointerEnabled ? "Remote control — click, drag, scroll and type to control the remote machine" : "Remote keyboard and scroll — pointer input unavailable" : "Pan local screen view"}
              >{touchMode === "trackpad" && cursorPreview && <span ref={cursorMarker} className="remote-trackpad-cursor" aria-hidden="true" />}</div>
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
