import { uniqueMetadataKeys, validateGeometry, type CaptureGeometry } from './remoteFrame';

export const MAX_VIDEO_PACKET = 8 * 1024 * 1024;
export interface VideoPacket { geometry: CaptureGeometry; timestamp: number; codec: string; data: Uint8Array }

/** Every packet must be independently decodable: SPS, PPS and an IDR. */
export function parseVideoPacket(packet: Uint8Array): VideoPacket {
  if (packet.length < 9 || packet.length > MAX_VIDEO_PACKET || String.fromCharCode(...packet.subarray(0, 4)) !== 'H264') throw new Error('Invalid video packet');
  const size = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(4, true);
  if (size < 2 || size > 16384 || 8 + size >= packet.length) throw new Error('Invalid video metadata size');
  const json = new TextDecoder('utf-8', { fatal: true }).decode(packet.subarray(8, 8 + size));
  if (!uniqueMetadataKeys(json)) throw new Error('Duplicate video metadata');
  const metadata = JSON.parse(json);
  const geometry = validateGeometry(metadata, { allowNullDesktop: true });
  if (!geometry || geometry.frame_width > 16384 || geometry.frame_height > 16384 || geometry.frame_width * geometry.frame_height > 33_554_432
    || metadata.keyframe !== true || !Number.isSafeInteger(metadata.timestamp_us) || metadata.timestamp_us < 0) throw new Error('Invalid video geometry');
  const data = packet.subarray(8 + size);
  let codec = '', pps = false, idr = false;
  for (let p = 0; p + 4 < data.length; p++) {
    let n = 0;
    if (data[p] === 0 && data[p + 1] === 0) {
      if (data[p + 2] === 1) n = p + 3;
      else if (data[p + 2] === 0 && data[p + 3] === 1) n = p + 4;
    }
    if (!n || n >= data.length) continue;
    const type = data[n] & 31;
    if (type === 7 && n + 3 < data.length) codec = 'avc1.' + Array.from(data.subarray(n + 1, n + 4), b => b.toString(16).padStart(2, '0')).join('');
    if (type === 8) pps = true;
    if (type === 5) idr = true;
    p = n;
  }
  if (!codec || !pps || !idr) throw new Error('Video packet is not independently decodable');
  return { geometry, timestamp: metadata.timestamp_us, codec, data };
}

/** Fixed bounds independent of fetch chunk boundaries; at most one packet allocated. */
export class VideoPacketParser {
  private header = new Uint8Array(4);
  private headerSize = 0;
  private packet: Uint8Array | null = null;
  private used = 0;
  push(chunk: Uint8Array, receive: (packet: VideoPacket) => void): void {
    let p = 0;
    while (p < chunk.length) {
      if (!this.packet) {
        const n = Math.min(4 - this.headerSize, chunk.length - p);
        this.header.set(chunk.subarray(p, p + n), this.headerSize); this.headerSize += n; p += n;
        if (this.headerSize < 4) continue;
        const size = new DataView(this.header.buffer).getUint32(0, true);
        if (size < 9 || size > MAX_VIDEO_PACKET) throw new Error('Video frame exceeds the size limit');
        this.packet = new Uint8Array(size); this.used = 0; this.headerSize = 0;
      }
      const n = Math.min(this.packet.length - this.used, chunk.length - p);
      this.packet.set(chunk.subarray(p, p + n), this.used); this.used += n; p += n;
      if (this.used === this.packet.length) {
        const packet = this.packet; this.packet = null; this.used = 0;
        receive(parseVideoPacket(packet));
      }
    }
  }
  finish(): void { if (this.packet || this.headerSize) throw new Error('Video stream ended inside a frame'); }
}
