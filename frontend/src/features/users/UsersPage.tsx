import { useState } from "react";
import { Spinner } from "@vantyr/ui/components/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@vantyr/ui/components/tabs";
import { CreateUserModal } from "./CreateUserModal";
import { EditUserModal } from "./EditUserModal";
import { OidcIdentitiesModal } from "./OidcIdentitiesModal";
import { ResetPasswordModal } from "./ResetPasswordModal";
import { ConfirmUserDialog, ErrorBanner } from "./UserDialogParts";
import { roleChangeConsequence, userLabel } from "./userDirectory";
import { UserProfileCard } from "./UserProfileCard";
import { UsersDirectory } from "./UsersDirectory";
import { useUserManagement, type UserManagement } from "./useUserManagement";

type AccountTab = "users" | "profile";

export function UsersPage() {
  const m = useUserManagement();
  const [tab, setTab] = useState<AccountTab>("users");
  const { me } = m;

  if (!me) {
    return m.meLoading ? (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Loading your account…
      </p>
    ) : (
      <ErrorBanner
        message={`Couldn't load your account: ${m.meError ?? "Failed to load"}`}
        onRetry={() => void m.reloadAccounts()}
        retrying={m.usersFetching}
      />
    );
  }

  const remember = (u: { id: string }) =>
    m.rememberOpener(document.querySelector<HTMLElement>(`[data-manage-user="${u.id}"]`));
  const profile = <UserProfileCard me={me} onSave={m.saveSelfProfile} />;

  return (
    <div className="flex flex-col gap-6">
      {m.meError && (
        <ErrorBanner
          message={`Couldn't refresh your account: ${m.meError}. Showing what loaded last.`}
          onRetry={() => void m.reloadAccounts()}
          retrying={m.usersFetching}
        />
      )}
      {m.canManage ? (
        <Tabs value={tab} onValueChange={(value) => setTab(value as AccountTab)}>
          <div className="mb-4 border-b border-border/70">
            <TabsList variant="line" aria-label="Account sections" className="h-11! gap-2 p-0">
              <TabsTrigger value="users" className="h-full! flex-none px-3 after:bottom-0!">
                Users{m.users ? ` (${m.users.length})` : ""}
              </TabsTrigger>
              <TabsTrigger value="profile" className="h-full! flex-none px-3 after:bottom-0!">
                My profile
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="users" className="pt-0">
            <UsersDirectory
              users={m.users}
              fetching={m.usersFetching}
              loadError={m.usersError}
              meId={me.id}
              onReload={() => void m.reloadAccounts()}
              onCreate={() => {
                m.rememberOpener(null);
                m.setCreateOpen(true);
              }}
              actions={{
                onEdit: (u) => {
                  remember(u);
                  m.setEditTarget(u);
                },
                onSetRole: (u, role) => {
                  remember(u);
                  m.askRole(u, role);
                },
                onResetPassword: (u) => {
                  remember(u);
                  m.setPasswordTarget({ id: u.id, username: u.username, name: userLabel(u) });
                },
                onIdentities: (u) => {
                  remember(u);
                  m.setIdentityTarget({ id: u.id, username: u.username, name: userLabel(u) });
                },
                onDelete: (u) => {
                  remember(u);
                  m.askDelete(u);
                },
              }}
            />
          </TabsContent>
          <TabsContent value="profile" className="pt-0">
            {profile}
          </TabsContent>
        </Tabs>
      ) : (
        <>
          {profile}
          <p className="text-sm text-muted-foreground">Only admins can manage other users.</p>
        </>
      )}
      {m.canManage && <UserDialogs m={m} meId={me.id} />}
    </div>
  );
}

/** Every dialog the Users page opens; each reports its own failure and can't be closed while it works. */
function UserDialogs({ m, meId }: { m: UserManagement; meId: string }) {
  const { roleTarget, deleteTarget } = m;
  const roleSelf = roleTarget?.user.id === meId;
  return (
    <>
      <CreateUserModal
        visible={m.createOpen}
        onDismiss={() => m.setCreateOpen(false)}
        finalFocus={m.finalFocus}
        onCreate={m.createAccount}
      />

      <EditUserModal
        user={m.editTarget}
        isSelf={m.editTarget?.id === meId}
        onDismiss={() => m.setEditTarget(null)}
        finalFocus={m.finalFocus}
        onSave={m.saveOtherProfile}
      />

      <ResetPasswordModal
        visible={Boolean(m.passwordTarget)}
        onDismiss={() => m.setPasswordTarget(null)}
        finalFocus={m.finalFocus}
        name={m.passwordTarget?.name ?? ""}
        isSelf={m.passwordTarget?.id === meId}
        onConfirm={m.resetPassword}
      />

      <OidcIdentitiesModal
        visible={Boolean(m.identityTarget)}
        onDismiss={() => m.setIdentityTarget(null)}
        finalFocus={m.finalFocus}
        name={m.identityTarget?.name ?? ""}
        identities={m.identities}
        loadError={m.identitiesError}
        loading={m.identitiesFetching}
        onReload={m.reloadIdentities}
        onLink={m.linkAccountIdentity}
        onUnlink={m.unlinkAccountIdentity}
      />

      <ConfirmUserDialog
        open={roleTarget !== null}
        pending={m.changingRole}
        title={
          roleTarget
            ? `Make ${userLabel(roleTarget.user)} ${roleTarget.role === "admin" ? "an" : "a"} ${roleTarget.role}?`
            : "Change role?"
        }
        confirmLabel="Change role"
        destructive={roleSelf && roleTarget?.role !== "admin"}
        finalFocus={m.finalFocus}
        error={m.roleError}
        errorPrefix="Couldn't change the role"
        onClose={() => m.setRoleTarget(null)}
        onConfirm={() => void m.confirmRole()}
      >
        {roleTarget &&
          roleChangeConsequence(roleTarget.user, roleTarget.role, roleSelf).map((line) => (
            <p key={line}>{line}</p>
          ))}
      </ConfirmUserDialog>

      <ConfirmUserDialog
        open={deleteTarget !== null}
        pending={m.deleting}
        title={`Delete ${deleteTarget ? userLabel(deleteTarget) : "this user"}?`}
        confirmLabel="Delete user"
        destructive
        finalFocus={m.finalFocus}
        error={m.deleteError}
        errorPrefix="Couldn't delete"
        onClose={() => m.setDeleteTarget(null)}
        onConfirm={() => void m.confirmDelete()}
      >
        <p>They are signed out now and can't sign in again. This can't be undone.</p>
        <p>
          Their linked identities, two-factor setup and notification subscriptions are removed. Past
          audit records stay.
        </p>
      </ConfirmUserDialog>
    </>
  );
}
