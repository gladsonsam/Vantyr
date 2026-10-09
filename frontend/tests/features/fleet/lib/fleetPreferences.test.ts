import { describe, expect, it } from "vitest";
import { fleetPreferenceScope, parseFleetPreferences } from "@/features/fleet/lib/fleetPreferences";
describe("fleet preference decoding", () => {
  it("scopes independently by full server API URL and user identity", () => {
    expect(fleetPreferenceScope("https://one/api/", "user-a")).not.toBe(fleetPreferenceScope("https://one/api/", "user-b"));
    expect(fleetPreferenceScope("https://one/api/", "user-a")).not.toBe(fleetPreferenceScope("https://two/api/", "user-a"));
    expect(fleetPreferenceScope("https://one/api/", "user-a")).not.toBe(fleetPreferenceScope("https://one/other-api/", "user-a"));
  });
  it("rejects corrupt values, deduplicates IDs, and discards malformed views", () => {
    expect(parseFleetPreferences("not JSON")).toEqual({ favorites: [], views: [] });
    expect(parseFleetPreferences(JSON.stringify({ favorites: ["uuid-a", "uuid-a", 42, null], views: [null, {}, { name: "Invalid", sort: { key: "unknown" } }] }))).toEqual({ favorites: ["uuid-a"], views: [] });
    expect(parseFleetPreferences('[]')).toEqual({ favorites: [], views: [] });
  });
});
