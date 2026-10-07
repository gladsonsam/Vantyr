import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { dashboardRoleLabel, type DashboardSessionUser } from "@/api/types";
import { DashboardUserAvatar } from "./DashboardUserAvatar";
import { UserAvatarFields } from "./UserAvatarFields";
import { profileValuesFor, type ProfileValues } from "./userProfile";

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
  const [values, setValues] = useState<ProfileValues>(() => profileValuesFor(me));
  // Every fresh `/me` (first load, refresh, reload after a change) re-seeds the profile form.
  const [seededAt, setSeededAt] = useState(version);
  if (version !== seededAt) {
    setSeededAt(version);
    setValues(profileValuesFor(me));
  }

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle>Your profile</CardTitle>
        <CardDescription>
          Your full name, sign-in username, and avatar. Changing username changes how you log in.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 px-5 pb-5">
        <div className="flex items-center gap-4 pt-1">
          <DashboardUserAvatar
            username={values.username || me.username}
            displayName={values.display_name}
            displayIcon={values.display_icon || null}
            size={56}
          />
          <div className="min-w-0">
            <div className="truncate font-semibold">{values.display_name.trim() || me.username}</div>
            <div className="text-sm text-muted-foreground">
              @{me.username} · {dashboardRoleLabel(me.role)}
            </div>
          </div>
        </div>
        <UserAvatarFields
          fullName={values.display_name}
          setFullName={(display_name) => setValues({ ...values, display_name })}
          username={values.username}
          setUsername={(username) => setValues({ ...values, username })}
          icon={values.display_icon}
          setIcon={(display_icon) => setValues({ ...values, display_icon })}
          idLabel="Must be unique. Use letters, numbers, or common punctuation."
          isNarrow={isNarrow}
          onImportError={onImportError}
        />
        <div>
          <Button disabled={saving} onClick={() => onSave(values)}>
            {saving && <Spinner />} Save profile
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
