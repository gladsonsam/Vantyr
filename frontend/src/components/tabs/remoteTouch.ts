import { remoteImagePoint, type ImageBounds } from "@/lib/remotePointer";
export type TouchMode = "direct" | "trackpad";
export type TouchAction = "tap" | "right" | "drag" | "scroll" | "pan";
export type Point = { x: number; y: number };
/** Bound each TypeText packet well below the agent's 2,000-character limit. */
export function remoteTextChunks(text: string): string[] {
  const chars = Array.from(text);
  if (chars.length > 8000) throw new Error("Send up to 8,000 characters at a time.");
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += 512) chunks.push(chars.slice(i, i + 512).join(""));
  return chunks;
}
export function trackpadPoint(bounds: ImageBounds, width: number, height: number, cursor: Point, dx: number, dy: number): Point | null {
  if (![width, height, bounds.width, bounds.height, dx, dy].every(Number.isFinite) || Math.min(width, height, bounds.width, bounds.height) <= 0) return null;
  const scale = Math.min(bounds.width / width, bounds.height / height);
  return { x: Math.max(0, Math.min(width - 1, Math.round(cursor.x + dx / scale))), y: Math.max(0, Math.min(height - 1, Math.round(cursor.y + dy / scale))) };
}
export function clampPan(point: Point, width: number, height: number, zoom: number, imageWidth = width, imageHeight = height): Point {
  if (![width, height, zoom, point.x, point.y].every(Number.isFinite) || width <= 0 || height <= 0) return { x: 0, y: 0 };
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth <= 0 || imageHeight <= 0) { imageWidth = width; imageHeight = height; }
  const scale = Math.min(width / imageWidth, height / imageHeight);
  const x = Math.max(0, (imageWidth * scale * zoom - width) / 2), y = Math.max(0, (imageHeight * scale * zoom - height) / 2);
  return { x: Math.max(-x, Math.min(x, point.x)) || 0, y: Math.max(-y, Math.min(y, point.y)) || 0 };
}
export function touchPoint(mode: TouchMode, bounds: ImageBounds, width: number, height: number, client: Point, cursor: Point, delta: Point, drag = false) {
  return mode === "direct" ? remoteImagePoint(bounds, width, height, client.x, client.y, drag) : trackpadPoint(bounds, width, height, cursor, delta.x, delta.y);
}

export function cursorLocation(bounds: ImageBounds, width: number, height: number, point: Point): Point | null {
  if (![bounds.width, bounds.height, width, height].every(Number.isFinite) || Math.min(bounds.width, bounds.height, width, height) <= 0) return null;
  const scale = Math.min(bounds.width / width, bounds.height / height);
  return { x: bounds.left + (bounds.width - width * scale) / 2 + point.x * scale, y: bounds.top + (bounds.height - height * scale) / 2 + point.y * scale };
}
