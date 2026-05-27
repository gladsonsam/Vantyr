import { useCallback, useState, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Box from "@cloudscape-design/components/box";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Button from "@cloudscape-design/components/button";
import Toggle from "@cloudscape-design/components/toggle";
import FormField from "@cloudscape-design/components/form-field";
import Modal from "@cloudscape-design/components/modal";
import Input from "@cloudscape-design/components/input";
import Select from "@cloudscape-design/components/select";
import { mjpegStreamUrl, notifyMjpegViewerLeft, type MjpegStreamTuning } from "../../lib/api";
import { StreamStatus } from "../common/StatusIndicator";
import Alert from "@cloudscape-design/components/alert";
import type { DashboardRole } from "../../lib/types";

interface ScreenTabProps {
  agentId: string;
  sendWsMessage: (msg: unknown) => void;
  dashboardRole?: DashboardRole | null;
  /** When false, the MJPEG request is not started (tab hidden / navigated away). */
  streamActive?: boolean;
}

type StreamPreset = "saver" | "balanced" | "sharp";

const STREAM_PRESET_STORAGE_KEY = "sentinel.dashboard.screenStreamPreset";

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
}: ScreenTabProps) {
  const [streaming, setStreaming] = useState(false);
  const [streamEverLoaded, setStreamEverLoaded] = useState(false);
  const [streamError, setStreamError] = useState(false);
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

  return (
    <>
      <Container
        header={
          <Header
            variant="h2"
            actions={
              <div className="sentinel-screen-header-actions">
                <div className="sentinel-screen-header__status">
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
                <div className="sentinel-screen-header__preset">
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
                <div className="sentinel-screen-header__toggle">
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
                  <span className="sentinel-screen-header__btn-text">Send notification</span>
                </Button>
                <Button
                  iconName={fullscreen ? "close" : "expand"}
                  disabled={blockedByRole || !streamEnabled}
                  ariaLabel={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                  onClick={toggleFullscreen}
                >
                  <span className="sentinel-screen-header__btn-text">{fullscreen ? "Exit" : "Fullscreen"}</span>
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
          className={`sentinel-screen-viewer${fullscreen ? " sentinel-screen-viewer-fullscreen" : ""}`}
          style={{ position: "relative" }}
        >
          <div className="sentinel-screen-frame">
            <img
              key={
                streamEnabled && mjpegStreamSession
                  ? `${agentId}-mjpeg-${mjpegStreamSession}`
                  : `${agentId}-mjpeg-off`
              }
              ref={imgRef}
              src={streamEnabled ? streamUrl : ""}
              alt="Agent screen"
              className="sentinel-screen-image"
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
                className="sentinel-remote-overlay"
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
