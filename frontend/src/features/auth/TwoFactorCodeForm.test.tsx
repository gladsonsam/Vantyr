// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, byLabel, click, fieldErrors, mountForm, typeInto, unmountForms } from "@/test/formDom";
import { TwoFactorCodeForm } from "./TwoFactorCodeForm";
import { disableCodeSchema, enrollCodeSchema } from "./twoFactorSchemas";

afterEach(unmountForms);

describe("two-factor code schemas", () => {
  it("needs 6 characters to enroll and any non-blank code to disable, trimming both", () => {
    expect(enrollCodeSchema.safeParse({ code: "12345" }).success).toBe(false);
    expect(enrollCodeSchema.parse({ code: " 123456 " }).code).toBe("123456");
    expect(disableCodeSchema.safeParse({ code: "  " }).success).toBe(false);
    expect(disableCodeSchema.parse({ code: " abc-def " }).code).toBe("abc-def");
  });
});

describe("TwoFactorCodeForm", () => {
  it("keeps the button disabled until the code is acceptable, then submits it trimmed", async () => {
    const onSubmit = vi.fn();
    await mountForm(
      <TwoFactorCodeForm schema={enrollCodeSchema} id="code" label="Code" submitLabel="Enable 2FA" busy={false} onSubmit={onSubmit} />,
    );
    expect(buttonByText("Enable 2FA").disabled).toBe(true);
    await typeInto(byLabel("Code"), "12345");
    expect(buttonByText("Enable 2FA").disabled).toBe(true);
    expect(fieldErrors()).toEqual([]);
    await typeInto(byLabel("Code"), " 123456 ");
    await click(buttonByText("Enable 2FA"));
    expect(onSubmit).toHaveBeenCalledWith({ code: "123456" });
  });

  it("disables everything while busy", async () => {
    await mountForm(
      <TwoFactorCodeForm schema={disableCodeSchema} id="code" label="Code" submitLabel="Disable 2FA" busy onSubmit={vi.fn()} />,
    );
    expect(byLabel("Code").disabled).toBe(true);
    expect(buttonByText("Disable 2FA").disabled).toBe(true);
  });
});
