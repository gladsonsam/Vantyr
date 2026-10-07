// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, byLabel, click, mountForm, typeInto, unmountForms } from "@/test/formDom";
import { EnrollmentTokenForm } from "./EnrollmentTokenForm";

afterEach(unmountForms);

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
    await typeInto(byLabel("Uses"), "0");
    expect(byLabel("Uses").value).toBe("1");
    await typeInto(byLabel("Uses"), "250000");
    expect(byLabel("Uses").value).toBe("100000");
    await typeInto(byLabel("Expires in (hours)"), "72");
    await typeInto(byLabel("Note (optional)"), "  lab pc ");
    await click(buttonByText("Generate code"));
    expect(onGenerate).toHaveBeenCalledWith({ uses: 100_000, expires_in_hours: 72, note: "lab pc" });
  });

  it("shows extra actions next to the button", async () => {
    await mountForm(<EnrollmentTokenForm layout="card" onGenerate={vi.fn(async () => {})} extra={<button type="button">Copy code</button>} />);
    expect(buttonByText("Copy code")).toBeTruthy();
  });
});
