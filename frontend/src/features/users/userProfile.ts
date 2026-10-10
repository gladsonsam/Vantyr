import type { UserProfileBody } from "@/api/queries/users";
import type { DashboardUser } from "@/api/types";

export interface ProfileValues {
  display_name: string;
  username: string;
  display_icon: string;
}

/** What a user's profile form shows when it opens (or re-seeds). */
export function profileValuesFor(user: Pick<DashboardUser, "display_name" | "username" | "display_icon">): ProfileValues {
  return {
    display_name: user.display_name?.trim() ?? "",
    username: user.username,
    display_icon: user.display_icon?.trim() ?? "",
  };
}

/** Only the fields that differ from the stored user; empty when nothing changed. */
export function profileChanges(
  user: Pick<DashboardUser, "display_name" | "username" | "display_icon">,
  values: ProfileValues,
): UserProfileBody {
  const body: UserProfileBody = {};
  const name = values.display_name.trim();
  if (name !== (user.display_name?.trim() ?? "")) body.display_name = name;
  const username = values.username.trim();
  if (username !== user.username) body.username = username;
  const icon = values.display_icon.trim();
  if (icon !== (user.display_icon?.trim() ?? "")) body.display_icon = icon.length > 0 ? icon : null;
  return body;
}
