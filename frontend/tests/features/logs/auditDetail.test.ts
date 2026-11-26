import { describe, expect, it } from "bun:test";
import { formatAuditAction, formatAuditDetail, isPageView } from "@/features/logs/auditDetail";

describe("formatAuditDetail", () => {
  it("labels command and unwraps a JSON error message", () => {
    const v = formatAuditDetail("run_command", {
      cmd_type: "ListDir",
      error: '{"code":"module_not_authorized","message":"module not authorized"}',
    });
    expect(v.pairs).toEqual([
      { label: "Command", value: "ListDir" },
      { label: "Error", value: "module not authorized" },
    ]);
    expect(v.full).toContain("cmd_type");
  });

  it("falls back to the error code and tolerates truncated JSON", () => {
    expect(formatAuditDetail("x", { error: '{"code":"module_rep' }).pairs[0].value).toBe(
      '{"code":"module_rep',
    );
    expect(formatAuditDetail("x", { error: '{"code":"not_allowed"}' }).pairs[0].value).toBe(
      "not allowed",
    );
  });

  it("returns nothing for empty or paging-only details", () => {
    expect(formatAuditDetail("x", {}).pairs).toEqual([]);
    expect(formatAuditDetail("x", { limit: 50, offset: 0 }).full).toBeNull();
    expect(formatAuditDetail("x", null).pairs).toEqual([]);
  });

  it("handles plain string details and log views", () => {
    expect(formatAuditDetail("x", "boom").pairs).toEqual([{ label: "Detail", value: "boom" }]);
    expect(formatAuditDetail("view_agent_logs", { kind: "agent", max_kb: 64 }).pairs).toEqual([
      { label: "Source", value: "agent" },
      { label: "Max KB", value: "64" },
    ]);
  });
});

describe("formatAuditAction", () => {
  it("names known actions and tidies the rest", () => {
    expect(formatAuditAction("view_urls")).toBe("View URLs");
    expect(formatAuditAction("update_network_policy")).toBe("Update Internet Block");
    expect(formatAuditAction("rotate_api_key")).toBe("Rotate Api Key");
  });

  it("treats only view_ actions as page views", () => {
    expect(isPageView("view_keys")).toBe(true);
    expect(isPageView("run_script")).toBe(false);
  });
});
