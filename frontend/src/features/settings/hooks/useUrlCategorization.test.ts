import { describe, expect, it } from "vitest";
import { urlCatJobProgress, urlCatJobRunning, type UrlCategorizationStatus } from "./useUrlCategorization";

const status = (job: Partial<NonNullable<UrlCategorizationStatus["job"]>> | null): UrlCategorizationStatus => ({
  settings: { enabled: true, auto_update: true, source_url: "https://x", last_update_at: null, last_update_error: null },
  active_release: { sha256: null },
  counts: { categories: 0, domains: 0, urls: 0 },
  job: job === null ? null : { state: "idle", started_at: null, updated_at: "", bytes_total: null, bytes_done: 0, message: null, ...job },
});

describe("urlCatJobRunning", () => {
  it("is true only while downloading or importing", () => {
    expect(urlCatJobRunning(status({ state: "downloading" }))).toBe(true);
    expect(urlCatJobRunning(status({ state: "importing" }))).toBe(true);
    expect(urlCatJobRunning(status({ state: "ready" }))).toBe(false);
    expect(urlCatJobRunning(status({ state: "error" }))).toBe(false);
    expect(urlCatJobRunning(status(null))).toBe(false);
    expect(urlCatJobRunning(null)).toBe(false);
    expect(urlCatJobRunning(undefined)).toBe(false);
  });
});

describe("urlCatJobProgress", () => {
  it("is the downloaded percentage, floored and capped at 100", () => {
    expect(urlCatJobProgress(status({ bytes_total: 200, bytes_done: 51 }))).toBe(25);
    expect(urlCatJobProgress(status({ bytes_total: 100, bytes_done: 250 }))).toBe(100);
  });

  it("is 0 when the total is unknown or there is no job", () => {
    expect(urlCatJobProgress(status({ bytes_total: null, bytes_done: 10 }))).toBe(0);
    expect(urlCatJobProgress(status({ bytes_total: 0, bytes_done: 10 }))).toBe(0);
    expect(urlCatJobProgress(status(null))).toBe(0);
    expect(urlCatJobProgress(null)).toBe(0);
  });
});
