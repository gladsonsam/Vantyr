import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent } from "@vantyr/ui/components/card";
import { Spinner } from "@vantyr/ui/components/spinner";
import { dashboardRoleLabel, type DashboardSessionUser } from "@/api/types";
import { DashboardUserAvatar } from "./DashboardUserAvatar";
import { UserAvatarFields } from "./UserAvatarFields";
import { DialogError } from "./UserDialogParts";
import type { ProfileValues } from "./userProfile";
import { useProfileForm } from "./useProfileForm";

interface UserProfileCardProps {
  me: DashboardSessionUser;
  /** Rejects with why the profile could not be saved; the card shows it. */
  onSave: (values: ProfileValues) => Promise<void>;
}

/** The signed-in user's own profile: name, username and avatar. */
export function UserProfileCard({ me, onSave }: UserProfileCardProps) {
  const { form, current, changed, newUsername, valid, saving, error, saved, submit, discard } = useProfileForm(me, onSave);
  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex flex-col gap-5 p-5">
        <div className="flex items-center gap-4">
          <DashboardUserAvatar username={current.username || me.username} displayName={current.display_name} displayIcon={current.display_icon || null} size={56} />
          <div className="min-w-0">
            <div className="truncate font-heading text-lg font-semibold">{current.display_name.trim() || me.username}</div>
            <div className="truncate text-sm text-muted-foreground">
              @{me.username} · {dashboardRoleLabel(me.role)}
            </div>
          </div>
        </div>
        <form onSubmit={submit} noValidate className="flex flex-col gap-5" aria-label="Your profile">
          <UserAvatarFields control={form.control} usernameHint="Must be unique. Changing it changes how you sign in." disabled={saving} />
          {newUsername && <p className="text-sm text-muted-foreground">You'll sign in with “{newUsername}” after saving.</p>}
          <DialogError prefix="Couldn't save" message={error} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={saving || !changed || !valid}>
              {saving && <Spinner />} Save profile
            </Button>
            {changed && !saving && (
              <Button type="button" variant="ghost" onClick={discard}>
                Discard changes
              </Button>
            )}
            {saved && !changed && !error && (
              <span role="status" className="text-sm text-muted-foreground">
                Profile saved.
              </span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
