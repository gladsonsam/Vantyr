// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, byLabel, click, mountForm, typeInto, unmountForms } from "@tests/support/formDom";
import { EnrollmentTokenForm } from "@/features/enrollment/EnrollmentTokenForm";

afterEach(unmountForms);

const optionsButton = () => {
  const button = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Options"));
  if (!button) throw new Error("no Options button");
  return button;
};

describe("EnrollmentTokenForm", () => {
  it("generates with the defaults", async () => {
    const onGenerate = vi.fn(async () => {});
    await mountForm(<EnrollmentTokenForm layout="card" onGenerate={onGenerate} />);
    await click(buttonByText("Generate code"));
    expect(onGenerate).toHaveBeenCalledWith({ uses: 1 });
  });

  it("clamps uses, sends the expiry and trims the note", async () => {
    const onGenerate = vi.fn(async () => {});
    await mountForm(<EnrollmentTokenForm layout="dialog" onGenerate={onGenerate} />);
    await click(optionsButton());
    await typeInto(byLabel("Uses"), "0");
    expect(byLabel("Uses").value).toBe("1");
    await typeInto(byLabel("Uses"), "250000");
    expect(byLabel("Uses").value).toBe("100000");
    await typeInto(byLabel("Expires in (hours)"), "72");
    await typeInto(byLabel("Note (optional)"), "  lab pc ");
    await click(buttonByText("Generate code"));
    expect(onGenerate).toHaveBeenCalledWith({ uses: 100_000, expires_in_hours: 72, note: "lab pc" });
  });

  it("keeps the dialog options collapsed until asked, but still generates with defaults", async () => {
    const onGenerate = vi.fn(async () => {});
    await mountForm(<EnrollmentTokenForm layout="dialog" onGenerate={onGenerate} />);
    expect(document.getElementById("enroll-uses")).toBeNull();
    expect(optionsButton().textContent).toContain("1 use · expires in 10 min");
    expect(optionsButton().getAttribute("aria-expanded")).toBe("false");
    await click(buttonByText("Generate code"));
    expect(onGenerate).toHaveBeenCalledWith({ uses: 1 });
    await click(optionsButton());
    expect(optionsButton().getAttribute("aria-expanded")).toBe("true");
    expect(byLabel("Uses")).toBeTruthy();
  });

  it("keeps the collapsed summary in step with what Generate will send", async () => {
    await mountForm(<EnrollmentTokenForm layout="dialog" onGenerate={vi.fn(async () => {})} />);
    await click(optionsButton());
    await typeInto(byLabel("Uses"), "3");
    await typeInto(byLabel("Expires in (hours)"), "0");
    await click(optionsButton());
    expect(optionsButton().textContent).toContain("3 uses · expires in 1h");
  });

  it("shows extra actions next to the button", async () => {
    await mountForm(<EnrollmentTokenForm layout="card" onGenerate={vi.fn(async () => {})} extra={<button type="button">Copy code</button>} />);
    expect(buttonByText("Copy code")).toBeTruthy();
  });
});
