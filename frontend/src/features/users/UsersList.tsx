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
            className="w-[5.5rem] pointer-coarse:h-9"
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
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-b border-border/60 px-4 py-3 last:border-b-0 hover:bg-muted/40 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
      <div className="flex min-w-0 items-center gap-3">
        <DashboardUserAvatar
          username={user.username}
          displayName={user.display_name}
          displayIcon={user.display_icon}
          size={36}
        />
        <div className="min-w-0 flex-1">
          <h3 className="flex min-w-0 items-baseline gap-2 text-sm font-medium">
            <span className="truncate">{label}</span>
            {user.id === meId && (
              <span className="shrink-0 text-xs font-normal text-muted-foreground">You</span>
            )}
          </h3>
          {hasName && <p className="truncate text-xs text-muted-foreground">@{user.username}</p>}
        </div>
      </div>
      <div className="row-start-2 col-start-1 flex items-center gap-4 pl-12 sm:contents">
        <span
          className={`inline-flex items-center gap-1.5 text-sm font-medium sm:col-start-2 sm:row-start-1 ${ROLE_TEXT[user.role]}`}
        >
          <RoleIcon className="size-4" aria-hidden /> {user.role}
        </span>
        {created ? (
          <span
            className="text-sm text-muted-foreground sm:col-start-3 sm:row-start-1"
            title={created.full}
          >
            Created {created.short}
          </span>
        ) : (
          <span className="sm:col-start-3" />
        )}
      </div>
      <div className="col-start-2 row-start-1 shrink-0 sm:col-start-4">
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
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card/10">
      <div
        aria-hidden
        className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-x-4 border-b border-border/70 px-4 py-2.5 text-xs font-medium text-muted-foreground sm:grid"
      >
        <span>User</span>
        <span>Role</span>
        <span>Created</span>
        <span className="w-[5.5rem]" />
      </div>
      <ul aria-label="Users">
        {users.map((u) => (
          <UserRow key={u.id} user={u} allUsers={allUsers} meId={meId} actions={actions} />
        ))}
      </ul>
    </div>
  );
}
