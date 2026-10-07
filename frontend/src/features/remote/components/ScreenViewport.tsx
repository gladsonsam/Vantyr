import type { ReactNode, RefObject } from "react";
import { Monitor } from "lucide-react";
import type { RemoteInput } from "@/features/remote/hooks/useRemoteInput";
import type { FrameSource } from "@/features/remote/lib/screenStreamSource";

export interface ViewportInput {
  /** Show the input overlay (control held, or panning the local view). */
  show: boolean;
  overlayRef: RefObject<HTMLDivElement | null>;
  handlers: RemoteInput["overlayHandlers"];
  label: string;
  /** Draw the trackpad cursor marker. */
  showCursor: boolean;
  cursorRef: RefObject<HTMLSpanElement | null>;
}

/** Focusable layer over the frame that receives pointer, wheel and keyboard input. */
function InputOverlay({ input: { show, overlayRef, handlers, label, showCursor, cursorRef } }: { input: ViewportInput }) {
  if (!show) return null;
  return (
    <div
      ref={overlayRef}
      className="vantyr-remote-overlay"
      {...handlers}
      tabIndex={0}
      role="application"
      aria-label={label}
    >{showCursor && <span ref={cursorRef} className="remote-trackpad-cursor" aria-hidden="true" />}</div>
  );
}

/**
 * The live screen container: the frame (from the stream source), its status overlays and the
 * input overlay, plus `children` (toolbar, dialogs) inside the same fullscreen tree. `embedded`
 * is the agent page's panel; `card` the standalone screen card's viewer.
 */
export function ScreenViewport({
  layout,
  containerRef,
  onFocusLeave,
  frames,
  streamEnabled,
  frameVisible,
  online,
  aspectRatio,
  fullscreen,
  pseudoFs,
  transform,
  placeholder,
  input,
  children,
}: {
  layout: "embedded" | "card";
  containerRef: RefObject<HTMLDivElement | null>;
  /** Focus moved out of the viewer. */
  onFocusLeave: () => void;
  frames: FrameSource;
  streamEnabled: boolean;
  frameVisible: boolean;
  online: boolean;
  aspectRatio: string | null;
  fullscreen: boolean;
  pseudoFs: boolean;
  transform: string;
  /** Embedded placeholder before the first frame: headline and optional detail lines. */
  placeholder: { title: string; detail?: string; window?: string };
  input: ViewportInput;
  children: ReactNode;
}) {
  const onBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onFocusLeave();
  };

  if (layout === "card") {
    return (
      <div
        ref={containerRef}
        onBlur={onBlur}
        className={`screen-remote-panel vantyr-screen-viewer${fullscreen ? " vantyr-screen-viewer-fullscreen screen-remote-maximized" : ""}${pseudoFs ? " screen-remote-maximized" : ""}`}
        style={{ position: "relative", ...(pseudoFs ? { position: "fixed", inset: 0, zIndex: 3000, display: "flex", flexDirection: "column", width: "100vw" } as const : {}) }}
      >
        <div className="vantyr-screen-frame screen-remote-stage">
          {frames.render({ layout: "card", streamEnabled, visible: frameVisible, transform })}
          <InputOverlay input={input} />
        </div>
        {children}
      </div>
    );
  }

  const isMaximized = fullscreen || pseudoFs;
  const selfLive = frames.selfLive;
  return (
    <div
      ref={containerRef}
      onBlur={onBlur}
      className={`screen-remote-panel flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-card${isMaximized ? " screen-remote-maximized" : ""}${isMaximized ? " bg-black!" : ""}`}
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
      <div className="screen-remote-stage" style={{ position: "relative", width: "100%", ...(isMaximized ? { flex: 1, minHeight: 0 } : streamEnabled || selfLive ? { aspectRatio: aspectRatio ?? "16 / 9", maxHeight: "min(58vh, 600px)" } : { height: 160 }), background: "#0a0b0d", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1.4px)", backgroundSize: "22px 22px" }} />
        {frames.render({ layout: "embedded", streamEnabled, visible: frameVisible, transform })}

        {/* LIVE / OFFLINE badge */}
        <div className="absolute top-3.5 left-3.5 flex items-center gap-[7px] rounded-lg border border-white/10 bg-black/50 px-2.5 py-[5px]">
          <span className={`size-[7px] rounded-full ${online ? "bg-destructive" : "bg-muted-foreground"}`} />
          <span className={`text-[11px] font-bold tracking-[0.08em] ${online ? "text-white" : "text-muted-foreground"}`}>{online ? "LIVE" : "OFFLINE"}</span>
        </div>
        <div className="absolute top-3.5 right-3.5 font-mono text-[11px] text-muted-foreground">
          {frameVisible || selfLive ? "MJPEG · live" : online ? "connecting…" : "—"}
        </div>

        {!frameVisible && !selfLive && (
          <div className="relative p-4 text-center">
            <div className={`mx-auto mb-3.5 flex size-15 items-center justify-center rounded-2xl bg-muted/70 ${online ? "text-success" : "text-muted-foreground"}`}>
              <Monitor size={28} />
            </div>
            <div className="text-sm font-semibold text-muted-foreground">{placeholder.title}</div>
            {placeholder.detail && (
              <div className="mt-1 text-xs text-muted-foreground">{placeholder.detail}</div>
            )}
            {placeholder.window && (
              <div className="mt-1 font-mono text-xs text-muted-foreground">{placeholder.window}</div>
            )}
          </div>
        )}

        <InputOverlay input={input} />
      </div>

      {children}
    </div>
  );
}
