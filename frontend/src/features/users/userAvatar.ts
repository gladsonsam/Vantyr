/** Prefix for Lucide icon keys stored in `display_icon` (matches lucide-react export names). */
const USER_AVATAR_LUCIDE_PREFIX = "icon:lucide:";

export function encodeUserLucideIcon(pascalName: string): string {
  return `${USER_AVATAR_LUCIDE_PREFIX}${pascalName}`;
}

export function parseUserLucideIcon(displayIcon: string | null | undefined): string | null {
  const t = displayIcon?.trim();
  if (!t?.startsWith(USER_AVATAR_LUCIDE_PREFIX)) return null;
  const name = t.slice(USER_AVATAR_LUCIDE_PREFIX.length);
  return name.length > 0 ? name : null;
}

export function isUserPhotoDataUrl(displayIcon: string | null | undefined): boolean {
  const t = displayIcon?.trim() ?? "";
  return t.startsWith("data:image/");
}

const MAX_DATA_URL_BYTES = 235_000;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not read image file"));
    img.src = url;
  });
}

/** Resize to fit inside a square and export as JPEG data URL for server storage. */
export async function resizeImageFileToJpegDataUrl(
  file: File,
  maxEdgePx: number,
  quality: number,
): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const { naturalWidth: width, naturalHeight: height } = img;
    if (width <= 0 || height <= 0) throw new Error("Invalid image dimensions");
    const scale = Math.min(1, maxEdgePx / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale)),
      h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not use canvas");
    ctx.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (dataUrl.length > MAX_DATA_URL_BYTES)
      throw new Error("Photo is still too large after resizing; try a smaller image.");
    return dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
}
