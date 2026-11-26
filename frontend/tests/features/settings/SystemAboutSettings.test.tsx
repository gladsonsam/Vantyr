import { buttonByText, click, mountForm, unmountForms } from "@tests/support/formDom";
import { testMock as vi } from "@tests/support/mock";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

await vi.mock("@/api", () => ({
  errorText: (e: unknown) => String(e instanceof Error ? e.message : e),
}));

const { SystemAboutSettings } = await import("@/features/settings/SystemAboutSettings");

type Props = Parameters<typeof SystemAboutSettings>[0];
const NOW = new Date("2026-11-26T03:10:00").getTime();
const payload = {
  server_version: "0.2.8",
  latest_server_release: "0.2.9",
  server_update_available: true,
  latest_agent_version: "0.2.9",
  releases_url: "https://example.com/releases",
};
const usage = {
  database_bytes: 3 * 1024 * 1024,
  public_tables_bytes: 2 * 1024 * 1024,
  other_bytes: 1024 * 1024,
  tables: [{ name: "window_events", bytes: 2048 }],
};

const onReload = vi.fn();
const props = (
  over: Partial<{ [K in keyof Props]: Partial<Props[K]> }> = {},
  isAdmin = true,
): Props =>
  ({
    isAdmin,
    storage: {
      data: usage,
      error: null,
      loading: false,
      updatedAt: NOW,
      onReload,
      ...over.storage,
    },
    version: {
      data: payload,
      error: null,
      loading: false,
      updatedAt: NOW,
      onReload,
      ...over.version,
    },
    autoUpdate: {
      data: { enabled: true },
      error: null,
      loading: false,
      onReload,
      onSave: vi.fn(async () => undefined),
      ...over.autoUpdate,
    },
  }) as Props;
const render = (p: Props) => mountForm(<SystemAboutSettings {...p} />);
const text = () => document.body.textContent ?? "";

beforeEach(() => vi.clearAllMocks());
afterEach(unmountForms);

describe("server version", () => {
  it("names the running and latest versions and says an update is available", async () => {
    await render(props());
    expect(text()).toContain("Update available: 0.2.9");
    expect(text()).toContain("Running0.2.8");
    expect(text()).toContain("Latest release0.2.9");
    await click(buttonByText("Check for updates"));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("only says Up to date from a successful answer that names a latest release", async () => {
    await render(
      props({
        version: { data: { ...payload, server_version: "0.2.9", server_update_available: false } },
      }),
    );
    expect(text()).toContain("Up to date");
  });

  it("does not say Up to date when GitHub gave no latest release", async () => {
    await render(
      props({
        version: {
          data: { ...payload, latest_server_release: null, server_update_available: false },
        },
      }),
    );
    expect(text()).toContain("Latest release unknown");
    expect(text()).not.toContain("Up to date");
  });

  it("shows no version claim when the check failed, and offers a retry", async () => {
    await render(props({ version: { data: null, error: "no network" } }));
    expect(text()).toContain("Couldn't check for updates. no network");
    expect(text()).not.toContain("Up to date");
    expect(text()).not.toContain("Update available");
    await click(buttonByText("Try again"));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("keeps an earlier result labelled with when it was checked when a re-check fails", async () => {
    await render(
      props({
        version: {
          data: { ...payload, server_update_available: false, latest_server_release: "0.2.8" },
          error: "no network",
        },
      }),
    );
    expect(text()).toContain("Couldn't check GitHub just now. Showing the result from");
    expect(text()).toContain("checked");
  });
});

describe("storage usage", () => {
  it("shows sizes with when they were read and the per-table details", async () => {
    await render(props());
    expect(text()).toContain("Total database size3.00 MB");
    expect(text()).toContain("As of");
    expect(text()).toContain("Details by table (1)");
    expect(text()).toContain("window_events");
  });

  it("never shows dashes as sizes when the load failed", async () => {
    await render(props({ storage: { data: null, error: "boom" } }));
    expect(text()).toContain("Couldn't load storage usage. boom");
    expect(text()).not.toContain("Total database size");
  });

  it("keeps the last sizes with a notice when a refresh fails", async () => {
    await render(props({ storage: { error: "boom" } }));
    expect(text()).toContain("Couldn't refresh usage. Showing the sizes from");
    expect(text()).toContain("3.00 MB");
  });
});

describe("agent auto-update default", () => {
  it("saves a change, shows the confirmed state, and reports a refusal", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Server said no"));
    await render(props({ autoUpdate: { onSave } }));
    const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await click(toggle);
    expect(onSave).toHaveBeenCalledWith(false);
    expect(text()).toContain("Not saved. Server said no");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("shows no switch when the default could not be loaded", async () => {
    await render(props({ autoUpdate: { data: null, error: "boom" } }));
    expect(text()).toContain("Couldn't load the agent auto-update default. boom");
    expect(document.querySelector('[role="switch"]')).toBeNull();
  });

  it("is read-only for non-admins", async () => {
    await render(props({}, false));
    const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.hasAttribute("disabled") || toggle.getAttribute("aria-disabled") === "true").toBe(
      true,
    );
    expect(text()).toContain("Only admins can change this default.");
  });
});
