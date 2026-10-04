export interface ImageBounds { left: number; top: number; width: number; height: number }

/** Map a contained image to its encoded pixels, excluding letterbox clicks. */
export function remoteImagePoint(bounds: ImageBounds, width: number, height: number, clientX: number, clientY: number, clampDrag = false): { x: number; y: number } | null {
  if (![bounds.left, bounds.top, bounds.width, bounds.height, width, height, clientX, clientY].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0 || width <= 0 || height <= 0) return null;
  const scale = Math.min(bounds.width / width, bounds.height / height);
  const renderedWidth = width * scale, renderedHeight = height * scale;
  const x = clientX - bounds.left - (bounds.width - renderedWidth) / 2;
  const y = clientY - bounds.top - (bounds.height - renderedHeight) / 2;
  if (!clampDrag && (x < 0 || y < 0 || x > renderedWidth || y > renderedHeight)) return null;
  return {
    x: Math.max(0, Math.min(Math.ceil(width) - 1, Math.floor(x / scale))),
    y: Math.max(0, Math.min(Math.ceil(height) - 1, Math.floor(y / scale))),
  };
}
