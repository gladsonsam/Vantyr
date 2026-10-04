import type { CaptureGeometry } from "../lib/remoteFrame";
export const encode = (s: string) => new TextEncoder().encode(s);
export const concat = (...parts: Uint8Array[]) => {
  const output = new Uint8Array(parts.reduce((size, p) => size + p.length, 0));
  let position = 0; for (const part of parts) { output.set(part, position); position += part.length; } return output;
};
// Reuse the real baseline JPEG bytes used by the parser's actual-source fixture.
const baseline = Uint8Array.from(atob("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKBTmCNl4x9lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHz/wAARCAAYABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDEooorpOUKKKKAP//Z"), c => c.charCodeAt(0));
export const frameGeometry = (revision = 1): CaptureGeometry => ({ capture_id: "5e6334d6-9b8f-4dc5-8ef0-b3ff5c53126b", geometry_revision: revision, monitor_index: 1,
  desktop: { x: -1080, y: -200, physical_width: 1080, physical_height: 1920 }, frame_width: 16, frame_height: 24 });
export function frameJpeg(geometry: unknown = frameGeometry()): Uint8Array {
  if (geometry === null) return baseline.slice();
  const payload = concat(encode("VantyrGeometry\0"), encode(JSON.stringify({type:"capture_geometry",schema_version:1,geometry})));
  const n = payload.length + 2;
  return concat(baseline.subarray(0,2), new Uint8Array([0xff,0xef,n >> 8,n & 255]), payload, baseline.subarray(2));
}
export const framePart = (jpeg = frameJpeg()): Uint8Array => concat(encode(`--testframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),jpeg,encode("\r\n"));
export function deferred<T>() {
  let resolve!: (value:T) => void, reject!: (error:unknown) => void;
  const promise = new Promise<T>((yes,no) => {resolve=yes;reject=no;}); return {promise,resolve,reject};
}
export async function settle() { for (let i=0;i<12;i++) await Promise.resolve(); }
