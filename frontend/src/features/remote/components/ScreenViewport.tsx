import type { CSSProperties, ReactNode, RefObject } from "react";
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

  const placeholderContent = <ScreenPlaceholder visible={!frameVisible && !frames.selfLive} placeholder={placeholder} />;

  if (layout === "card") {
    return (
      <div
        ref={containerRef}
        onBlur={onBlur}
        className={`screen-remote-panel vantyr-screen-viewer${fullscreen ? " vantyr-screen-viewer-fullscreen screen-remote-maximized" : ""}${pseudoFs ? " screen-remote-maximized" : ""}`}
        style={cardPanelStyle(pseudoFs)}
      >
        <div className="vantyr-screen-frame screen-remote-stage" style={cardStageStyle(fullscreen || pseudoFs, aspectRatio)}>
          {frames.render({ layout: "card", streamEnabled, visible: frameVisible, transform })}
          {placeholderContent}
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
      style={embeddedPanelStyle(isMaximized, pseudoFs)}
    >
      <div className="screen-remote-stage" style={embeddedStageStyle(isMaximized, streamEnabled || selfLive, aspectRatio)}>
        <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1.4px)", backgroundSize: "22px 22px" }} />
        {frames.render({ layout: "embedded", streamEnabled, visible: frameVisible, transform })}

        {/* A quiet live dot; the placeholder below already explains connecting and offline. */}
        {online && (frameVisible || selfLive) && (
          <span title="Live desktop" className="remote-live-badge">Live</span>
        )}

        {placeholderContent}

        <InputOverlay input={input} />
      </div>

      {children}
    </div>
  );
}

function ScreenPlaceholder({ visible, placeholder }: { visible: boolean; placeholder: { title: string; detail?: string; window?: string } }) {
  if (!visible) return null;
  return <div className="remote-screen-placeholder" role="status">
    <Monitor size={28} aria-hidden="true" />
    <strong>{placeholder.title}</strong>
    {placeholder.detail && <span>{placeholder.detail}</span>}
    {placeholder.window && <span>{placeholder.window}</span>}
  </div>;
}
function cardPanelStyle(pseudoFs: boolean): CSSProperties {
  return { position: "relative", ...(pseudoFs ? { position: "fixed", inset: 0, zIndex: 3000, display: "flex", flexDirection: "column", width: "100vw" } as const : {}) };
}
function cardStageStyle(maximized: boolean, aspectRatio: string | null): CSSProperties | undefined {
  return maximized ? undefined : { aspectRatio: aspectRatio ?? "16 / 9", maxHeight: "70vh", minHeight: 160 };
}
function embeddedPanelStyle(maximized: boolean, pseudoFs: boolean): CSSProperties {
  return { flex: "1 1 0", ...(maximized ? { borderRadius: 0 } : {}), ...(pseudoFs ? { position: "fixed", inset: 0, zIndex: 3000, width: "100vw", height: "100vh" } as const : {}) };
}
function embeddedStageStyle(maximized: boolean, active: boolean, aspectRatio: string | null): CSSProperties {
  return { position: "relative", width: "100%", ...(maximized ? { flex: 1, minHeight: 0 } : active ? { aspectRatio: aspectRatio ?? "16 / 9", maxHeight: "min(58vh, 600px)" } : { height: 160 }), background: "#0a0b0d", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" };
}
