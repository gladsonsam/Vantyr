import { createContext, useContext } from "react";
import type { ScreenStreamSource } from "@/features/remote/lib/screenStreamSource";
import { mjpegScreenStreamSource } from "./mjpegStreamSource";

/**
 * Where the live screen comes from. Defaults to the agent's MJPEG stream; the app root swaps in
 * another source (the demo build's fake desktop). The value must not change while mounted.
 */
export const ScreenStreamSourceContext = createContext<ScreenStreamSource>(mjpegScreenStreamSource);

export function useScreenStreamSource(): ScreenStreamSource {
  return useContext(ScreenStreamSourceContext);
}
