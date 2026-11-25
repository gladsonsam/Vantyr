export function videoPacket(revision = 1, overrides = {}): Uint8Array {
  const metadata = new TextEncoder().encode(JSON.stringify({ type: 'capture_geometry', schema_version: 1,
    geometry: { capture_id: '12345678-1234-4234-9234-123456789abc', geometry_revision: revision, monitor_index: 0,
      desktop: { x: -1920, y: 0, physical_width: 1920, physical_height: 1080 }, frame_width: 16, frame_height: 24 },
    keyframe: true, timestamp_us: revision, ...overrides }));
  const data = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0, 0x1f, 0, 0, 1, 0x68, 1, 0, 0, 1, 0x65, 1]);
  const packet = new Uint8Array(8 + metadata.length + data.length);
  packet.set(new TextEncoder().encode('H264')); new DataView(packet.buffer).setUint32(4, metadata.length, true);
  packet.set(metadata, 8); packet.set(data, 8 + metadata.length); return packet;
}
export function wirePacket(packet = videoPacket()): Uint8Array {
  const wire = new Uint8Array(packet.length + 4); new DataView(wire.buffer).setUint32(0, packet.length, true); wire.set(packet, 4); return wire;
}
