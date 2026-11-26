import { describe, expect, it } from "bun:test";
import {
  MAX_VIDEO_PACKET,
  parseVideoPacket,
  VideoPacketParser,
} from "@/features/remote/lib/videoFrame";

import { videoPacket, wirePacket } from "../hooks/videoTestFixtures";
describe("independently decodable bounded H264 transport", () => {
  it("preserves verified geometry and derives codec from the actual SPS", () => {
    const packet = parseVideoPacket(videoPacket());
    expect(packet.codec).toBe("avc1.42001f");
    expect(packet.geometry.desktop?.x).toBe(-1920);
  });
  it("accepts split and coalesced packet headers and payloads", () => {
    const parser = new VideoPacketParser(),
      received: number[] = [];
    for (const b of wirePacket())
      parser.push(new Uint8Array([b]), (p) => received.push(p.geometry.geometry_revision));
    const joined = new Uint8Array([...wirePacket(videoPacket(2)), ...wirePacket(videoPacket(3))]);
    parser.push(joined, (p) => received.push(p.geometry.geometry_revision));
    parser.finish();
    expect(received).toEqual([1, 2, 3]);
  });
  it("rejects excessive allocation, truncated frames, delta frames and missing parameter sets", () => {
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, MAX_VIDEO_PACKET + 1, true);
    expect(() => new VideoPacketParser().push(size, () => {})).toThrow("size limit");
    const parser = new VideoPacketParser();
    parser.push(wirePacket().subarray(0, 20), () => {});
    expect(() => parser.finish()).toThrow("inside a frame");
    expect(() => parseVideoPacket(videoPacket(1, { keyframe: false }))).toThrow("geometry");
    const delta = videoPacket();
    delta[delta.length - 2] = 0x41;
    expect(() => parseVideoPacket(delta)).toThrow("independently");
    const missing = videoPacket();
    missing[missing.length - 7] = 0x69;
    expect(() => parseVideoPacket(missing)).toThrow("independently");
  });
  it("rejects oversized dimensions, bad timestamps and metadata", () => {
    expect(() => parseVideoPacket(videoPacket(1, { timestamp_us: -1 }))).toThrow();
    expect(() => parseVideoPacket(videoPacket(1, { geometry: { frame_width: 20000 } }))).toThrow();
    const packet = videoPacket();
    new DataView(packet.buffer).setUint32(4, 20000, true);
    expect(() => parseVideoPacket(packet)).toThrow("metadata");
  });
});
