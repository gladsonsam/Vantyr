import type { ReactNode } from "react";
import type { DisplayedRemoteFrame } from "@/features/remote/hooks/useMjpegFrames";
import type { CaptureGeometry } from "@/features/remote/lib/remoteFrame";

/** What pointer input maps onto: the on-screen frame box and its encoded pixel size. */
export interface FrameSurface {
  getBoundingClientRect: () => DOMRect;
  naturalWidth: number;
  naturalHeight: number;
}

export type CaptureStamp = Pick<CaptureGeometry, "capture_id" | "geometry_revision">;

/** Frame status pushed by a source; `size` comes with a presented frame. */
export interface FrameReport {
  streaming: boolean;
  error: boolean;
  size?: { width: number; height: number };
}

export interface FrameSourceOptions {
  agentId: string;
  /** Stream URL for the current session ("" when the stream is off). */
  streamUrl: string;
  session: string;
  /** The live view is on (tab visible, capture available). */
  streamEnabled: boolean;
  /** The stream may be fetched (live view on, device online, role allowed). */
  enabled: boolean;
  online: boolean;
  /** Called synchronously before a new frame is shown (real streams only). */
  onBeforeDisplay: (frame: DisplayedRemoteFrame | null) => void;
  report: (status: FrameReport) => void;
}

export interface FrameRenderProps {
  layout: "embedded" | "card";
  /** The live view is on (tab visible, capture available). */
  streamEnabled: boolean;
  /** A frame is loaded and should be visible. */
  visible: boolean;
  transform: string;
}

/** One screen stream as ScreenTab sees it, whatever produces the pixels. */
export interface FrameSource {
  /** Pointer-mapping surface for the frame on screen, if any. */
  surface: () => FrameSurface | null;
  /** The presented frame carries a verified physical desktop, so control may be offered. */
  verified: boolean;
  /** Same check against the frame displayed right now (between renders). */
  verifiedNow: () => boolean;
  /** Capture stamp for an input command: `ok: false` drops it (unverified display). */
  inputStamp: () => { ok: boolean; stamp: CaptureStamp | null };
  /** Stamp getter for the control lease; undefined when the source has no capture geometry. */
  leaseStamp?: () => CaptureStamp | null;
  /** The stream failed (offer Reconnect). */
  failed: boolean;
  /** Still waiting for the first frame of this session. */
  connecting: boolean;
  /** Frames should keep arriving; a long gap means the stream stalled. */
  detectsStalls: boolean;
  /** The source shows a live desktop on its own, with or without stream frames. */
  selfLive: boolean;
  /** Drop the stream now (the server is told the viewer left). */
  stop: () => void;
  render: (props: FrameRenderProps) => ReactNode;
}

export interface ScreenStreamSource {
  /** Hook: called once per ScreenTab render. Must stay the same for the app's lifetime. */
  useFrames: (options: FrameSourceOptions) => FrameSource;
  /** Desktop audio can be streamed. */
  audio: boolean;
  /** Shown with the audio tools when there is something to say (e.g. no audio). */
  audioNote?: string;
}
