import { describe, expect, it } from "vitest";
import { profileChanges, profileValuesFor } from "@/features/users/userProfile";

const user = { username: "jane", display_name: " Jane Doe ", display_icon: null };

describe("profileValuesFor", () => {
  it("trims the stored name and icon and fills blanks", () => {
    expect(profileValuesFor(user)).toEqual({ display_name: "Jane Doe", username: "jane", display_icon: "" });
    expect(profileValuesFor({ username: "bob", display_name: "", display_icon: null })).toEqual({ display_name: "", username: "bob", display_icon: "" });
  });
});

describe("profileChanges", () => {
  it("is empty when nothing changed, even if the stored name had stray spaces", () => {
    expect(profileChanges(user, profileValuesFor(user))).toEqual({});
  });

  it("reports only changed fields, trimmed", () => {
    expect(profileChanges(user, { display_name: "Jane D", username: " jane ", display_icon: "" })).toEqual({ display_name: "Jane D" });
    expect(profileChanges(user, { display_name: "Jane Doe", username: " janed ", display_icon: "" })).toEqual({ username: "janed" });
  });

  it("clears the icon with null and sets a new one as typed", () => {
    expect(profileChanges({ ...user, display_icon: "lucide:cat" }, { ...profileValuesFor(user), display_icon: "" })).toEqual({ display_icon: null });
    expect(profileChanges(user, { ...profileValuesFor(user), display_icon: " lucide:dog " })).toEqual({ display_icon: "lucide:dog" });
  });
});
