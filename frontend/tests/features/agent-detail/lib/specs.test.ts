import { describe, expect, it } from "bun:test";
import {
  driveUsage,
  formatDisplays,
  formatGb,
  formatMemoryGb,
  formatProcessor,
  mountAddsInfo,
  partitionAdapters,
  partitionIpAddresses,
  presentFacts,
  uniqueValues,
} from "@/features/agent-detail/lib/specs";
import { capabilityValueTone } from "@/features/agent-detail/lib/agentCapabilities";

describe("partitionIpAddresses", () => {
  it("splits IPv4 from IPv6, keeps order and drops blanks", () => {
    expect(
      partitionIpAddresses([" 10.0.0.2 ", "fe80::1", "", "192.168.1.5", "2001:db8::1"]),
    ).toEqual({
      v4: ["10.0.0.2", "192.168.1.5"],
      v6: ["fe80::1", "2001:db8::1"],
    });
  });
});

describe("partitionAdapters", () => {
  const ethernet = {
    name: "Ethernet",
    ips: ["10.0.2.20", "fe80::1"],
    gateways: ["10.0.2.1"],
    dns: ["1.1.1.1"],
  };
  const wifiUnplugged = { name: "WiFi", ips: ["169.254.42.42", "fe80::2"], gateways: [], dns: [] };
  const bluetooth = { name: "Bluetooth Network Connection", ips: ["169.254.36.104"] };
  const loopback = { name: "Loopback Pseudo-Interface 1", ips: ["127.0.0.1", "::1"] };
  const noAddress = { name: "Virtual", ips: [] };

  it("keeps connected adapters first and folds self-assigned, loopback and address-less ones away", () => {
    const { active, inactive } = partitionAdapters([
      wifiUnplugged,
      ethernet,
      bluetooth,
      loopback,
      noAddress,
    ]);
    expect(active.map((a) => a.name)).toEqual(["Ethernet"]);
    expect(inactive.map((a) => a.name)).toEqual([
      "WiFi",
      "Bluetooth Network Connection",
      "Loopback Pseudo-Interface 1",
      "Virtual",
    ]);
  });

  it("treats a link-local adapter that has a gateway as connected", () => {
    const { active } = partitionAdapters([
      { name: "Odd", ips: ["169.254.1.1"], gateways: ["169.254.1.254"] },
    ]);
    expect(active).toHaveLength(1);
  });

  it("recognises loopback by description as well as by address", () => {
    const { inactive } = partitionAdapters([
      { name: "lo0", description: "Software Loopback Interface 1", ips: ["10.9.9.9"] },
    ]);
    expect(inactive).toHaveLength(1);
  });
});

describe("uniqueValues", () => {
  it("dedupes, trims and drops empties", () => {
    expect(uniqueValues(["1.1.1.1", " 8.8.8.8", "1.1.1.1", ""])).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(uniqueValues(undefined)).toEqual([]);
  });
});

describe("drive helpers", () => {
  it("formats gigabytes with one decimal and grouped thousands", () => {
    expect(formatGb(826.09)).toBe("826.1 GB");
    expect(formatGb(41.2)).toBe("41.2 GB");
    expect(formatGb(1862.4)).toBe("1,862.4 GB");
  });

  it("computes used and percent, and is safe when the size is unknown", () => {
    expect(driveUsage({ total_gb: 200, available_gb: 50 })).toEqual({
      total: 200,
      free: 50,
      used: 150,
      pct: 75,
    });
    expect(driveUsage({ total_gb: 0, available_gb: 5 }).pct).toBe(0);
    expect(driveUsage({}).total).toBe(0);
    expect(driveUsage({ total_gb: 10, available_gb: 20 }).used).toBe(0);
  });

  it("shows the mount point only when it says more than the name", () => {
    expect(mountAddsInfo({ name: "C:", mount_point: "C:\\" })).toBe(false);
    expect(mountAddsInfo({ name: "Data", mount_point: "D:\\" })).toBe(true);
    expect(mountAddsInfo({ name: "Backups", mount_point: "E:\\Backups" })).toBe(true);
    expect(mountAddsInfo({ name: "C:" })).toBe(false);
  });
});

describe("device fact formatting", () => {
  it("summarises displays, marking the primary one only when there are several", () => {
    expect(
      formatDisplays([
        { width: 2560, height: 1440, primary: true },
        { width: 1920, height: 1080 },
      ]),
    ).toBe("2560×1440 primary, 1920×1080");
    expect(formatDisplays([{ width: 1920, height: 1080, primary: true }])).toBe("1920×1080");
    expect(formatDisplays(undefined)).toBe("");
  });

  it("formats memory and processor, leaving out what is missing", () => {
    expect(formatMemoryGb(32768)).toBe("32 GB");
    expect(formatMemoryGb(15884)).toBe("15.5 GB");
    expect(formatMemoryGb(undefined)).toBe("");
    expect(formatProcessor({ cpu_brand: "Intel Core i7", cpu_cores: 12 })).toBe(
      "Intel Core i7 · 12 cores",
    );
    expect(formatProcessor({ cpu_cores: 1 })).toBe("1 core");
    expect(formatProcessor({})).toBe("");
  });

  it("keeps only facts that have a value", () => {
    expect(
      presentFacts([
        { label: "A", value: "x" },
        { label: "B", value: "  " },
        { label: "C", value: undefined },
        { label: "D", value: "y", copy: true },
      ]),
    ).toEqual([
      { label: "A", value: "x", copy: undefined },
      { label: "D", value: "y", copy: true },
    ]);
  });
});

describe("capabilityValueTone", () => {
  it("separates fine, needs-attention and unavailable", () => {
    expect(capabilityValueTone("supported")).toBe("ok");
    expect(capabilityValueTone("Limited")).toBe("caution");
    expect(capabilityValueTone("needs_permission")).toBe("caution");
    expect(capabilityValueTone("unsupported")).toBe("off");
  });
});
