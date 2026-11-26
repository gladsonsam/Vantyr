import { describe, expect, it } from "bun:test";
import { createDemoNetworkRuntime } from "@/demo/networkRuntime";
import type { Availability } from "@/features/network/runtime/types";

function data<T>(value: Availability<T>): T {
  if (value.state !== "ready") throw new Error("expected ready data");
  return value.data;
}

describe("demo network runtime", () => {
  it("explains decisions against what is applied, never the saved proposal", async () => {
    const runtime = createDemoNetworkRuntime();
    const policy = data(await runtime.policy());
    // The fixture saves revision 15 on top of applied revision 14. It adds a rule for chat.example.
    expect(policy.applied?.revision).toBe(14);
    expect(policy.proposal?.revision).toBe(15);

    const decision = data(
      await runtime.explainDecision({
        deviceId: "dev-tablet",
        personId: "per-jo",
        domain: "chat.example",
      }),
    );
    expect(decision.effect).toBe("allow");
    expect(decision.layer).toBe("household_default");
    expect(decision.revision).toBe(14);
  });

  it("lets the household baseline win over an exception", async () => {
    const runtime = createDemoNetworkRuntime();
    await runtime.editPolicy({
      kind: "add_rule",
      layer: "baseline",
      scopeId: null,
      rule: {
        effect: "deny",
        match: { kind: "exact", value: "homework.example" },
        reason: "Test",
        schedule: null,
      },
    });
    // Saving only proposes it, so the applied baseline is unchanged and the exception still allows.
    const stillApplied = data(
      await runtime.explainDecision({
        deviceId: "dev-desktop",
        personId: "per-sam",
        domain: "homework.example",
      }),
    );
    expect(stillApplied.layer).toBe("exception");

    const baseline = data(
      await runtime.explainDecision({
        deviceId: "dev-desktop",
        personId: "per-sam",
        domain: "malware.example",
      }),
    );
    expect(baseline.effect).toBe("deny");
    expect(baseline.layer).toBe("baseline");
  });

  it("applies person rules only when a person is verified", async () => {
    const runtime = createDemoNetworkRuntime();
    const verified = data(
      await runtime.explainDecision({
        deviceId: "dev-desktop",
        personId: "per-jo",
        domain: "social.example",
      }),
    );
    expect(verified.effect).toBe("deny");
    expect(verified.layer).toBe("person");

    const unknown = data(
      await runtime.explainDecision({
        deviceId: "dev-desktop",
        personId: null,
        domain: "social.example",
      }),
    );
    expect(unknown.identity).toBe("unknown");
    expect(unknown.layer).toBe("household_default");
  });

  it("keeps a saved edit as a proposal until it is discarded", async () => {
    const runtime = createDemoNetworkRuntime();
    const edited = data(
      await runtime.editPolicy({
        kind: "add_rule",
        layer: "device",
        scopeId: "dev-tv",
        rule: {
          effect: "deny",
          match: { kind: "suffix", value: "new.example" },
          reason: "Test",
          schedule: null,
        },
      }),
    );
    expect(edited.applied?.revision).toBe(14);
    expect(edited.proposal?.deviceDefaults.find((s) => s.scopeId === "dev-tv")?.rules.length).toBe(
      2,
    );
    expect(edited.applied?.deviceDefaults.find((s) => s.scopeId === "dev-tv")?.rules.length).toBe(
      1,
    );

    const discarded = data(await runtime.editPolicy({ kind: "discard_proposal" }));
    expect(discarded.proposal).toBeNull();
    expect(discarded.applied?.revision).toBe(14);
  });

  it("pages events and filters by source without losing correlation ids", async () => {
    const runtime = createDemoNetworkRuntime();
    const first = data(await runtime.events({ limit: 10 }));
    expect(first.events).toHaveLength(10);
    expect(first.nextCursor).not.toBeNull();

    const dns = data(await runtime.events({ limit: 100, source: "dns" }));
    expect(dns.events.every((e) => e.source === "dns")).toBe(true);

    // One visit can be described by several sources; they share a correlation id.
    const all = data(await runtime.events({ limit: 200 }));
    const sourcesByCorrelation = new Map<string, Set<string>>();
    for (const event of all.events) {
      const sources = sourcesByCorrelation.get(event.correlationId) ?? new Set<string>();
      sources.add(event.source);
      sourcesByCorrelation.set(event.correlationId, sources);
    }
    expect([...sourcesByCorrelation.values()].some((sources) => sources.size > 1)).toBe(true);
  });
});
