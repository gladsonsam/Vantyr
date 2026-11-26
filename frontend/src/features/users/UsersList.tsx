import { Fingerprint, KeyRound, Settings2, Trash2, UserPen } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@vantyr/ui/components/dropdown-menu";
import type { DashboardRole, DashboardUser } from "@/api/types";
import { DashboardUserAvatar } from "./DashboardUserAvatar";
import { ROLE_ICON, ROLE_OPTIONS, ROLE_TEXT } from "./roles";
import { createdOn, deleteBlock, roleChangeBlock, userLabel } from "./userDirectory";

export interface UserActions {
  onEdit: (user: DashboardUser) => void;
  onSetRole: (user: DashboardUser, role: DashboardRole) => void;
  onResetPassword: (user: DashboardUser) => void;
  onIdentities: (user: DashboardUser) => void;
  onDelete: (user: DashboardUser) => void;
}

/** Everything one row can do, in one menu. What can't be done says why instead of vanishing. */
function ManageMenu({
  user,
  allUsers,
  meId,
  actions,
}: {
  user: DashboardUser;
  allUsers: DashboardUser[];
  meId: string | null;
  actions: UserActions;
}) {
  const label = userLabel(user);
  const demoteBlock = user.role === "admin" ? roleChangeBlock(user, "operator", allUsers) : null;
  const removeBlock = deleteBlock(user, allUsers, meId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="pointer-coarse:h-9"
            aria-label={`Manage ${label}`}
            data-manage-user={user.id}
          />
        }
      >
        <Settings2 /> Manage
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem onClick={() => actions.onEdit(user)}>
          <UserPen /> Edit name, username &amp; avatar
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Change role</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56">
            <DropdownMenuRadioGroup
              value={user.role}
              onValueChange={(value) => actions.onSetRole(user, value as DashboardRole)}
            >
              {ROLE_OPTIONS.map((o) => (
                <DropdownMenuRadioItem
                  key={o.value}
                  value={o.value}
                  disabled={
                    o.value !== user.role && roleChangeBlock(user, o.value, allUsers) !== null
                  }
                >
                  {o.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {demoteBlock && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs font-normal whitespace-normal">
                  {demoteBlock}
                </DropdownMenuLabel>
              </>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onClick={() => actions.onResetPassword(user)}>
          <KeyRound /> Reset password
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => actions.onIdentities(user)}>
          <Fingerprint /> Linked identities
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={removeBlock !== null}
          onClick={() => actions.onDelete(user)}
        >
          <Trash2 />
          <span className="flex min-w-0 flex-col">
            Delete user
            {removeBlock && (
              <span className="text-xs font-normal whitespace-normal text-muted-foreground">
                {removeBlock}
              </span>
            )}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserRow({
  user,
  allUsers,
  meId,
  actions,
}: {
  user: DashboardUser;
  allUsers: DashboardUser[];
  meId: string | null;
  actions: UserActions;
}) {
  const label = userLabel(user);
  const hasName = label !== user.username;
  const RoleIcon = ROLE_ICON[user.role];
  const created = createdOn(user.created_at);
  return (
    <li className="flex flex-col gap-3 border-b border-border/50 p-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <DashboardUserAvatar
          username={user.username}
          displayName={user.display_name}
          displayIcon={user.display_icon}
          size={40}
        />
        <div className="min-w-0 flex-1">
          <h3 className="flex min-w-0 items-baseline gap-2 text-base font-medium">
            <span className="truncate">{label}</span>
            {user.id === meId && (
              <span className="shrink-0 text-xs font-normal text-muted-foreground">You</span>
            )}
          </h3>
          {hasName && <p className="truncate text-sm text-muted-foreground">@{user.username}</p>}
          <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
            <span
              className={`inline-flex items-center gap-1.5 text-sm font-medium ${ROLE_TEXT[user.role]}`}
            >
              <RoleIcon className="size-3.5" aria-hidden /> {user.role}
            </span>
            {created && <span title={created.full}>Created {created.short}</span>}
          </p>
        </div>
      </div>
      <div className="shrink-0 pl-[3.25rem] sm:pl-0">
        <ManageMenu user={user} allUsers={allUsers} meId={meId} actions={actions} />
      </div>
    </li>
  );
}

/** One row per account, the same on every screen size. */
export function UsersList({
  users,
  allUsers,
  meId,
  actions,
}: {
  users: DashboardUser[];
  allUsers: DashboardUser[];
  meId: string | null;
  actions: UserActions;
}) {
  return (
    <ul aria-label="Users" className="rounded-xl border border-border/70 bg-card/10">
      {users.map((u) => (
        <UserRow key={u.id} user={u} allUsers={allUsers} meId={meId} actions={actions} />
      ))}
    </ul>
  );
}
