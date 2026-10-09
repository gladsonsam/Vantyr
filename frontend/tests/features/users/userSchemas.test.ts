import { describe, expect, it } from "vitest";
import { createUserSchema, linkIdentitySchema, profileSchema, resetPasswordSchema } from "@/features/users/userSchemas";

const messages = (result: { error?: { issues: { message: string }[] } }) => result.error?.issues.map((i) => i.message);

describe("userSchemas", () => {
  it("needs a non-blank username to create a user and a password of at least 6 characters", () => {
    const base = { display_name: "", username: "jane", password: "secret", role: "viewer" as const };
    expect(createUserSchema.safeParse(base).success).toBe(true);
    expect(messages(createUserSchema.safeParse({ ...base, username: "  " }))).toEqual(["Username is required."]);
    expect(messages(createUserSchema.safeParse({ ...base, password: "short" }))).toEqual(["Password must be at least 6 characters."]);
  });

  it("trims the username it parses", () => {
    expect(createUserSchema.parse({ display_name: "", username: " jane ", password: "secret", role: "admin" }).username).toBe("jane");
  });

  it("applies the same 6 character minimum when resetting a password", () => {
    expect(resetPasswordSchema.safeParse({ password: "12345" }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ password: "123456" }).success).toBe(true);
  });

  it("requires a username on profiles but allows a blank name and icon", () => {
    expect(profileSchema.safeParse({ display_name: "", username: "jane", display_icon: "" }).success).toBe(true);
    expect(messages(profileSchema.safeParse({ display_name: "", username: " ", display_icon: "" }))).toEqual(["Username is required."]);
  });

  it("needs both an issuer and a subject to link an identity", () => {
    expect(linkIdentitySchema.safeParse({ issuer: "https://idp", subject: "abc" }).success).toBe(true);
    expect(messages(linkIdentitySchema.safeParse({ issuer: " ", subject: "" }))).toEqual(["Issuer is required.", "Subject is required."]);
  });
});
