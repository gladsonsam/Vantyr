import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { DisplayedRemoteFrame } from "@/features/remote/hooks/useMjpegFrames";
import type { RemoteKeyboardHandle } from "@/features/remote/components/RemoteSoftwareKeyboard";
import { controlGeometryAvailable } from "@/features/remote/lib/remoteFrame";
import { RemoteHeldInput } from "@/features/remote/lib/remoteHeldInput";
import { buttonName, createWheelAccumulator, isModifierKey, keyDownAction } from "@/features/remote/lib/remoteKeys";
import { remoteImagePoint } from "@/features/remote/lib/remotePointer";
import { clampPan, cursorLocation, remoteTextChunks, touchPoint, type Point, type TouchAction, type TouchMode } from "@/features/remote/lib/remoteTouch";
import type { CaptureStamp, FrameSource, FrameSurface } from "@/features/remote/lib/screenStreamSource";

/**
 * Map a pointer position (clientX/Y) to remote-host pixel coordinates.
 *
 * The stream image uses `objectFit: contain`, so the rendered pixels may be
 * letterboxed / pillarboxed inside the element's CSS box (especially in
 * fullscreen where the viewport ratio can differ from the stream ratio).
 * We compute the actual rendered image area first, then map into it.
 */
function pointerToImageCoords(img: FrameSurface, clientX: number, clientY: number, clampDrag = false): Point | null {
  return remoteImagePoint(img.getBoundingClientRect(), img.naturalWidth, img.naturalHeight, clientX, clientY, clampDrag);
}

type Gesture = { id: number; start: Point; last: Point; point: Point; moved: boolean; scroll: Point; action: TouchAction };

/**
 * Remote control input over the live screen: mouse, touch (direct or trackpad, tap / right /
 * drag / scroll / local pan), wheel and keyboard mapped to agent commands, sent with the control
 * lease and the displayed frame's capture stamp. Tracks held keys/buttons so they are released
 * when control ends, focus leaves, the display changes or the frame geometry is replaced. Also
 * owns the local view (zoom, pan) and the trackpad cursor marker.
 */
export function useRemoteInput({
  agentId,
  sendWsMessage,
  leaseToken,
  inputEnabled,
  frames,
  monitorIndex,
  overlayRef,
  containerRef,
  keyboardRef,
  beforeDisplayRef,
  layout,
}: {
  agentId: string;
  sendWsMessage: (msg: unknown) => void;
  leaseToken: string | null;
  /** Control is held and allowed right now. */
  inputEnabled: boolean;
  frames: Pick<FrameSource, "surface" | "inputStamp" | "verifiedNow">;
  monitorIndex: number | null;
  overlayRef: RefObject<HTMLDivElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  keyboardRef: RefObject<RemoteKeyboardHandle | null>;
  /** Receives the frame-replacement handler (called by the stream before each new frame). */
  beforeDisplayRef: RefObject<(frame: DisplayedRemoteFrame | null) => void>;
  /** Layout inputs that move the frame on screen (re-place the trackpad cursor marker). */
  layout: { fullscreen: boolean; pseudoFs: boolean; aspectRatio: string | null };
}) {
  const { surface, inputStamp, verifiedNow } = frames;
  const lastPresentedIdentity = useRef<string | null>(null);
  const inputContext = useRef<{ agentId: string; token: string | null; stamp: CaptureStamp | null } | null>(null);
  /** rAF token for batching mouse-move messages. */
  const rafMoveRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<Point | null>(null);
  const heldInput = useRef(new RemoteHeldInput());
  const inputEnabledRef = useRef(false);
  const [touchMode, setTouchMode] = useState<TouchMode>("direct");
  const [touchAction, setTouchAction] = useState<TouchAction>("tap");
  const [inputError, setInputError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const cursor = useRef<Point | null>(null);
  const [cursorPreview, setCursorPreview] = useState<Point | null>(null);
  const cursorMarker = useRef<HTMLSpanElement>(null);
  const gesture = useRef<Gesture | null>(null);

  const pointerAllowedNow = () => inputEnabledRef.current && verifiedNow();
  // The overlay handlers below read this between renders; mirror the prop here
  // so they never close over a stale render snapshot.
  useEffect(() => {
    inputEnabledRef.current = inputEnabled;
  });

  useEffect(() => {
    return () => {
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
  }, [inputEnabled, overlayRef]);

  const ctrl = useCallback(
    (cmd: Record<string, unknown>, release = false) => {
      if (release && (cmd.type === "KeyUp" || cmd.type === "MouseUp")) {
        const context = inputContext.current;
        if (context) sendWsMessage({ type: "control", agent_id: context.agentId, lease_token: context.token, cmd: { ...cmd, ...context.stamp } });
        return;
      }
      if (!inputEnabledRef.current) return;
      const { ok, stamp } = inputStamp();
      if (!ok) return;
      inputContext.current = { agentId, token: leaseToken, stamp };
      sendWsMessage({ type: "control", agent_id: agentId, lease_token: leaseToken, cmd: { ...cmd, ...stamp } });
    },
    [agentId, sendWsMessage, leaseToken, inputStamp],
  );

  const releaseHeldInput = useCallback(() => {
    gesture.current = null;
    keyboardRef.current?.cancel();
    if (rafMoveRef.current != null) cancelAnimationFrame(rafMoveRef.current);
    rafMoveRef.current = null;
    pendingMoveRef.current = null;
    heldInput.current.releaseAll().forEach(cmd => ctrl(cmd, true));
    inputContext.current = null;
  }, [ctrl, keyboardRef]);
  useLayoutEffect(() => {
    beforeDisplayRef.current = frame => {
      const g = frame?.geometry;
      const identity = g ? `${g.capture_id}:${g.geometry_revision}` : null;
      if (lastPresentedIdentity.current !== identity || !frame || !controlGeometryAvailable(g)) {
        releaseHeldInput();
        cursor.current = null; setCursorPreview(null);
      }
      if (!controlGeometryAvailable(g)) inputEnabledRef.current = false;
      lastPresentedIdentity.current = identity;
    };
  }, [releaseHeldInput, beforeDisplayRef]);
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

  /** Stop accepting input until control is granted again (rejected / session ended). */
  const disable = useCallback(() => {
    inputEnabledRef.current = false;
    releaseHeldInput();
  }, [releaseHeldInput]);

  const sendText = useCallback((text: string) => {
    if (!inputEnabledRef.current) return false;
    try { remoteTextChunks(text).forEach(chunk => ctrl({ type: "TypeText", text: chunk })); setInputError(""); return true; }
    catch (error) { setInputError((error as Error).message); return false; }
  }, [ctrl]);
  useEffect(() => {
    cursor.current = null; setCursorPreview(null); setZoom(1); setPan({ x: 0, y: 0 }); setInputError("");
  }, [agentId, monitorIndex]);

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
  }, [zoom, surface, releasePointer, containerRef]);

  const { fullscreen, pseudoFs, aspectRatio } = layout;
  useLayoutEffect(() => {
    const img = surface(), marker = cursorMarker.current, overlay = overlayRef.current;
    if (!img || !marker || !overlay || !cursorPreview) return;
    const point = cursorLocation(img.getBoundingClientRect(), img.naturalWidth, img.naturalHeight, cursorPreview);
    if (!point) { marker.style.display = "none"; return; }
    const bounds = overlay.getBoundingClientRect();
    marker.style.display = "block"; marker.style.left = `${point.x - bounds.left}px`; marker.style.top = `${point.y - bounds.top}px`;
  }, [cursorPreview, zoom, pan, touchMode, fullscreen, pseudoFs, aspectRatio, surface, overlayRef]);

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

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
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

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
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

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
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
    const notches = createWheelAccumulator();
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      const scroll = notches(e);
      if (scroll) ctrl({ type: "MouseScroll", delta_x: scroll.dx, delta_y: scroll.dy });
    };
    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
  }, [inputEnabled, touchAction, ctrl, overlayRef]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!inputEnabledRef.current || e.nativeEvent.isComposing) return;
      e.preventDefault();
      const action = keyDownAction(e);
      if (!action) return;
      if (action.kind === "modifier") {
        if (heldInput.current.keyDown(action.key)) ctrl({ type: "KeyDown", key: action.key });
      } else if (action.kind === "special") {
        ctrl({ type: "KeyPress", key: action.key });
      } else if (action.kind === "char") {
        ctrl({ type: "KeyChar", char: action.char });
      } else {
        sendText(action.text);
      }
    },
    [ctrl, sendText],
  );

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!inputEnabledRef.current) return;
      e.preventDefault();
      if (isModifierKey(e.key)) {
        if (heldInput.current.keyUp(e.key.toLowerCase())) ctrl({ type: "KeyUp", key: e.key.toLowerCase() });
      }
    },
    [ctrl],
  );

  return {
    ctrl,
    sendText,
    releaseHeldInput,
    disable,
    /** Control is enabled right now (also false between renders once disabled). */
    enabledNow: () => inputEnabledRef.current,
    touchMode,
    setTouchMode,
    touchAction,
    setTouchAction,
    inputError,
    setInputError,
    zoom,
    setZoom,
    pan,
    setPan,
    cursorPreview,
    cursorMarkerRef: cursorMarker,
    /** Handlers for the input overlay above the frame. */
    overlayHandlers: {
      onPointerMove: handlePointerMove,
      onPointerDown: handlePointerDown,
      onPointerUp: handlePointerUp,
      onPointerCancel: releaseHeldInput,
      onLostPointerCapture: releasePointer,
      onBlur: releaseHeldInput,
      onKeyDown: handleKeyDown,
      onKeyUp: handleKeyUp,
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    },
  };
}

export type RemoteInput = ReturnType<typeof useRemoteInput>;
