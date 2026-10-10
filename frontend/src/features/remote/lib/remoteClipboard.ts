export const CLIPBOARD_TEXT_LIMIT = 64 * 1024;
export const CLIPBOARD_TIMEOUT_MS = 10_000;
export function clipboardTextFits(text: string): boolean {
  return new TextEncoder().encode(text).byteLength <= CLIPBOARD_TEXT_LIMIT;
}
