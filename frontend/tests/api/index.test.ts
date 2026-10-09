import { describe, it, expect } from "vitest";
import { ApiError, isApiError, errorText, historyRangeQuery, historySearchQuery } from "@/api/index";

describe("ApiError", () => {
  it("isApiError narrows only genuine ApiError instances", () => {
    expect(isApiError(new ApiError("x", 500))).toBe(true);
    expect(isApiError(new Error("x"))).toBe(false);
    expect(isApiError({ status: 404, message: "x" })).toBe(false);
    expect(isApiError(null)).toBe(false);
    expect(isApiError(undefined)).toBe(false);
  });
});

describe("errorText", () => {
  it("prefers ApiError/Error messages over String(e)", () => {
    expect(errorText(new ApiError("rate limited", 429))).toBe("rate limited");
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("plain string")).toBe("plain string");
    expect(errorText({ weird: true })).toBe("[object Object]");
  });
});

describe("Recall query encoding", () => {
  it("preserves display zero and safely encodes continuation filters", () => {
    const params = new URLSearchParams(historyRangeQuery({ monitor: 0, cursor: "opaque+/=", scope: "retained", sort: "newest", limit: 100 }));
    expect(params.get("monitor")).toBe("0");
    expect(params.get("cursor")).toBe("opaque+/=");
    expect(params.get("scope")).toBe("retained");
    expect(params.get("sort")).toBe("newest");
    expect(params.has("from")).toBe(false);
  });
});

it("encodes literal context filters and explicit clears without changing default OCR search",()=>{
  const legacy=new URLSearchParams(historySearchQuery("needle",{monitor:0}));expect(legacy.get("q")).toBe("needle");expect(legacy.has("context")).toBe(false);
  const params=new URLSearchParams(historySearchQuery("",{app:"editor_%\\.exe",app_mode:"prefix",title:"<img> %_ +&",url_host:null,context:"known",sort:"newest",cursor:"opaque+/="}));
  expect(params.get("app")).toBe("editor_%\\.exe");expect(params.get("app_mode")).toBe("prefix");expect(params.get("title")).toBe("<img> %_ +&");expect(params.get("url_host")).toBe("");expect(params.get("context")).toBe("known");expect(params.get("cursor")).toBe("opaque+/=");
});
