import { useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { dashboardRoleLabel, type DashboardSessionUser } from "@/api/types";
import { useServerForm } from "@/hooks/useServerForm";
import { DashboardUserAvatar } from "./DashboardUserAvatar";
import { UserAvatarFields } from "./UserAvatarFields";
import { profileValuesFor, type ProfileValues } from "./userProfile";
import { profileSchema } from "./userSchemas";

interface UserProfileCardProps {
  me: DashboardSessionUser;
  /** Changes whenever a fresh `/me` arrives; re-seeds the form. */
  version: number;
  isNarrow: boolean;
  saving: boolean;
  onSave: (values: ProfileValues) => void;
  onImportError: (message: string) => void;
}

/** The signed-in user's own profile: name, username and avatar. */
export function UserProfileCard({ me, version, isNarrow, saving, onSave, onImportError }: UserProfileCardProps) {
  // Every fresh `/me` (first load, refresh, reload after a change) re-seeds the profile form.
  const form = useServerForm<ProfileValues, DashboardSessionUser>({
    resolver: zodResolver(profileSchema),
    data: me,
    version,
    toValues: profileValuesFor,
    initial: profileValuesFor(me),
  });
  const values = useWatch({ control: form.control });
  const displayName = values.display_name ?? "";

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle>Your profile</CardTitle>
        <CardDescription>
          Your full name, sign-in username, and avatar. Changing username changes how you log in.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 px-5 pb-5">
        <form onSubmit={form.handleSubmit(onSave)} noValidate className="contents">
          <div className="flex items-center gap-4 pt-1">
            <DashboardUserAvatar
              username={values.username || me.username}
              displayName={displayName}
              displayIcon={values.display_icon || null}
              size={56}
            />
            <div className="min-w-0">
              <div className="truncate font-semibold">{displayName.trim() || me.username}</div>
              <div className="text-sm text-muted-foreground">
                @{me.username} · {dashboardRoleLabel(me.role)}
              </div>
            </div>
          </div>
          <UserAvatarFields
            control={form.control}
            idLabel="Must be unique. Use letters, numbers, or common punctuation."
            isNarrow={isNarrow}
            onImportError={onImportError}
          />
          <div>
            <Button type="submit" disabled={saving}>
              {saving && <Spinner />} Save profile
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
