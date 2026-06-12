import { Container, Header, Box, SpaceBetween, Button, Toggle, FormField, Modal, Input, Select, Alert } from "../ui/console";
import { Monitor, Maximize2, Minimize2, MousePointer2 } from "lucide-react";
import { useCallback, useState, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { mjpegStreamUrl, notifyMjpegViewerLeft, type MjpegStreamTuning } from "../../lib/api";
import { StreamStatus } from "../common/StatusIndicator";
import type { DashboardRole } from "../../lib/types";

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
}

type StreamPreset = "saver" | "balanced" | "sharp";

const STREAM_PRESET_STORAGE_KEY = "vantyr.dashboard.screenStreamPreset";

const STREAM_PRESET_TUNING: Record<StreamPreset, MjpegStreamTuning> = {
  saver: { jpegQ: 28, intervalMs: 500 },
  balanced: { jpegQ: 40, intervalMs: 200 },
  sharp: { jpegQ: 62, intervalMs: 120 },
};

const STREAM_PRESET_OPTIONS: Array<{ label: string; description: string; value: StreamPreset }> = [
  { label: "Bandwidth saver", description: "Lower quality / slower refresh (less CPU + network).", value: "saver" },
  { label: "Balanced", description: "Default remote viewing profile.", value: "balanced" },
  { label: "Sharper", description: "Higher quality / faster refresh (more CPU + network).", value: "sharp" },
];

function loadStreamPreset(): StreamPreset {
  try {
    const raw = localStorage.getItem(STREAM_PRESET_STORAGE_KEY);
    if (raw === "saver" || raw === "balanced" || raw === "sharp") return raw;
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

/** Map pointer position to remote host pixel coordinates (natural image size). */
function pointerToImageCoords(
  img: HTMLImageElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const rect = img.getBoundingClientRect();
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (nw <= 0 || nh <= 0 || rect.width <= 0 || rect.height <= 0) return null;
  const x = ((clientX - rect.left) / rect.width) * nw;
  const y = ((clientY - rect.top) / rect.height) * nh;
  return { x: Math.floor(x), y: Math.floor(y) };
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
}: ScreenTabProps) {
  const [streaming, setStreaming] = useState(false);
  const [streamEverLoaded, setStreamEverLoaded] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const [streamAspectRatio, setStreamAspectRatio] = useState<string | null>(null);
  const lastFrameAtMsRef = useRef<number | null>(null);
  const [remoteControl, setRemoteControl] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showNotificationModal, setShowNotificationModal] = useState(false);
  const [notificationTitle, setNotificationTitle] = useState("");
  const [notificationMessage, setNotificationMessage] = useState("");
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  /** Latest abort — avoids effect cleanups tied to `abortMjpeg` identity (session changes) clearing `<img src>`. */
  const abortMjpegRef = useRef<() => void>(() => {});

  /** Per visit to the screen tab; server ties MJPEG GET + explicit leave to this id. */
  const [mjpegStreamSession, setMjpegStreamSession] = useState("");
  const [streamPreset, setStreamPreset] = useState<StreamPreset>(() => loadStreamPreset());

  const blockedByRole = dashboardRole === "viewer";
  const streamEnabled = streamActive && !blockedByRole;

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

  const streamUrl = useMemo(
    () =>
      streamEnabled && mjpegStreamSession
        ? mjpegStreamUrl(agentId, mjpegStreamSession, streamTuning)
        : "",
    [streamEnabled, agentId, mjpegStreamSession, streamTuning],
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

  useEffect(() => {
    if (!streamActive) setRemoteControl(false);
  }, [streamActive]);

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
      const wrap = containerRef.current;
      if (wrap && document.fullscreenElement === wrap) {
        void document.exitFullscreen();
      }
    }
  }, [streamEnabled]);

  useEffect(() => {
    return () => {
      abortMjpegRef.current();
    };
  }, []);

  const sendMouseMove = useCallback(
    (clientX: number, clientY: number) => {
      const img = imgRef.current;
      if (!remoteControl || !img) return;
      const pt = pointerToImageCoords(img, clientX, clientY);
      if (!pt) return;
      sendWsMessage({
        type: "control",
        agent_id: agentId,
        cmd: { type: "MouseMove", x: pt.x, y: pt.y },
      });
    },
    [remoteControl, agentId, sendWsMessage],
  );

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!remoteControl || !e.isPrimary) return;
    sendMouseMove(e.clientX, e.clientY);
  };

  const handleMouseClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!remoteControl || !imgRef.current) return;
    e.preventDefault();
    const pt = pointerToImageCoords(imgRef.current, e.clientX, e.clientY);
    if (!pt) return;
    const button = e.button === 2 ? "right" : "left";
    sendWsMessage({
      type: "control",
      agent_id: agentId,
      cmd: { type: "MouseClick", x: pt.x, y: pt.y, button },
    });
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!remoteControl) return;
    e.preventDefault();

    const keyMap: Record<string, string> = {
      Enter: "enter",
      Backspace: "backspace",
      Tab: "tab",
      Escape: "escape",
    };

    const mapped = keyMap[e.key];
    if (mapped) {
      sendWsMessage({
        type: "control",
        agent_id: agentId,
        cmd: { type: "KeyPress", key: mapped },
      });
      return;
    }
    if (e.key.length === 1) {
      sendWsMessage({
        type: "control",
        agent_id: agentId,
        cmd: { type: "TypeText", text: e.key },
      });
    }
  };

  const handleSendNotification = () => {
    if (!notificationTitle.trim()) return;

    sendWsMessage({
      type: "control",
      agent_id: agentId,
      cmd: {
        type: "Notify",
        title: notificationTitle,
        message: notificationMessage,
      },
    });

    setShowNotificationModal(false);
    setNotificationTitle("");
    setNotificationMessage("");
  };

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;

    if (!document.fullscreenElement) {
      void requestViewportFullscreen(el);
    } else {
      void exitViewportFullscreen();
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

  if (embedded) {
    const showFrame = streamEnabled && streaming && !streamError;
    return (
      <div
        ref={containerRef}
        style={{
          flex: "1 1 0",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r)",
          overflow: "hidden",
        }}
      >
        <div style={{ position: "relative", width: "100%", ...(streamEnabled ? { aspectRatio: streamAspectRatio ?? "16 / 9" } : { height: 160 }), background: "#0a0b0d", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1.4px)", backgroundSize: "22px 22px" }} />
          {streamEnabled && streamUrl && (
            <img
              key={`${agentId}-mjpeg-${mjpegStreamSession}`}
              ref={imgRef}
              src={streamUrl}
              alt="Agent screen"
              onLoad={onFrameLoad}
              onError={onFrameError}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", display: showFrame ? "block" : "none" }}
            />
          )}

          {/* LIVE / OFFLINE badge */}
          <div style={{ position: "absolute", top: 14, left: 14, display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", borderRadius: 8, background: "rgba(0,0,0,0.5)", border: "1px solid var(--line-2)" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: online ? "var(--red)" : "var(--tx-3)", boxShadow: online ? "0 0 0 3px rgba(240,88,76,0.25)" : "none" }} />
            <span style={{ fontSize: 11, fontWeight: 700, color: online ? "#fff" : "var(--tx-3)", letterSpacing: "0.08em" }}>{online ? "LIVE" : "OFFLINE"}</span>
          </div>
          <div style={{ position: "absolute", top: 14, right: 14, fontSize: 11, color: "var(--tx-3)", fontFamily: "var(--mono)" }}>
            {showFrame ? "MJPEG · live" : online ? "connecting…" : "—"}
          </div>

          {!showFrame && (
            <div style={{ position: "relative", textAlign: "center", padding: 16 }}>
              <div style={{ width: 60, height: 60, borderRadius: 16, background: "var(--card-2)", border: "1px solid var(--line-2)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px", color: online ? "var(--gr)" : "var(--tx-3)" }}>
                <Monitor size={28} />
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--tx-2)" }}>
                {online ? (streamError ? "Stream unavailable" : streamEnabled ? "Connecting to live desktop…" : "Live view paused") : "Agent offline"}
              </div>
              {placeholderTitle && (
                <div style={{ fontSize: 12, color: "var(--tx-3)", marginTop: 4, fontFamily: "var(--mono)" }}>{placeholderTitle}</div>
              )}
            </div>
          )}

          {remoteControl && streamEnabled && (
            <div
              className="vantyr-remote-overlay"
              onPointerMove={handlePointerMove}
              onClick={handleMouseClick}
              onContextMenu={handleMouseClick}
              onKeyDown={handleKeyPress}
              tabIndex={0}
              role="application"
              aria-label="Remote control overlay — drag to move the cursor; tap to click"
            />
          )}
        </div>

        {/* control bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 14px", borderTop: "1px solid var(--line)" }}>
          <button
            type="button"
            onClick={() => setRemoteControl((v) => !v)}
            disabled={!streamEnabled}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 14px",
              borderRadius: 10,
              border: "none",
              background: remoteControl ? "var(--gr)" : "var(--card-2)",
              color: remoteControl ? "#06251a" : "var(--tx-2)",
              fontSize: 12.5,
              fontWeight: 700,
              cursor: streamEnabled ? "pointer" : "not-allowed",
              opacity: streamEnabled ? 1 : 0.5,
            }}
          >
            <MousePointer2 size={15} /> {remoteControl ? "Controlling" : "Take control"}
          </button>
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
            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />} {fullscreen ? "Exit" : "Fullscreen"}
          </button>
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
                        const v = detail.selectedOption?.value;
                        if (v === "saver" || v === "balanced" || v === "sharp") {
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
                <div className="vantyr-screen-header__toggle">
                  <Toggle
                    checked={remoteControl}
                    disabled={blockedByRole || !streamEnabled}
                    onChange={({ detail }) => setRemoteControl(detail.checked)}
                  >
                    Remote control
                  </Toggle>
                </div>
                <Button
                  iconName="notification"
                  disabled={blockedByRole || !streamEnabled}
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
        <div
          ref={containerRef}
          className={`vantyr-screen-viewer${fullscreen ? " vantyr-screen-viewer-fullscreen" : ""}`}
          style={{ position: "relative" }}
        >
          <div className="vantyr-screen-frame">
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
            {remoteControl && streamEnabled && (
              <div
                className="vantyr-remote-overlay"
                onPointerMove={handlePointerMove}
                onClick={handleMouseClick}
                onContextMenu={handleMouseClick}
                onKeyDown={handleKeyPress}
                tabIndex={0}
                role="application"
                aria-label="Remote control overlay — drag to move the cursor; tap to click"
              />
            )}
          </div>
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
                disabled={!notificationTitle.trim()}
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
