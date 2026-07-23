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

/** Resize to fit inside a square and export as JPEG data URL for server storage. */
export function resizeImageFileToJpegDataUrl(
  file: File,
  maxEdgePx: number,
  quality: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      if (w <= 0 || h <= 0) {
        reject(new Error("Invalid image dimensions"));
        return;
      }
      const scale = Math.min(1, maxEdgePx / Math.max(w, h));
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Could not use canvas"));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      let dataUrl: string;
      try {
        dataUrl = canvas.toDataURL("image/jpeg", quality);
      } catch (e) {
        reject(e instanceof Error ? e : new Error("Could not encode image"));
        return;
      }
      if (dataUrl.length > MAX_DATA_URL_BYTES) {
        reject(new Error("Photo is still too large after resizing; try a smaller image."));
        return;
      }
      resolve(dataUrl);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image file"));
    };
    img.src = url;
  });
}
