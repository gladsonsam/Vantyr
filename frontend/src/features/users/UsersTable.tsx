import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DashboardRole, DashboardUser } from "@/api/types";
import { DashboardUserAvatar } from "./DashboardUserAvatar";
import { ROLE_TEXT } from "./roles";

function RoleText({ role }: { role: DashboardRole }) {
  return <span className={`text-sm font-medium ${ROLE_TEXT[role]}`}>{role}</span>;
}

interface UsersTableProps {
  items: DashboardUser[];
  loading: boolean;
  isNarrow: boolean;
  canManage: boolean;
  onEdit: (user: DashboardUser) => void;
  onSetRole: (user: DashboardUser, role: DashboardRole) => void;
  onResetPassword: (user: DashboardUser) => void;
  onIdentities: (user: DashboardUser) => void;
  onDelete: (user: DashboardUser) => void;
}

/** The user directory: a table on wide screens, stacked cards on narrow ones. */
export function UsersTable({ items, loading, isNarrow, canManage, onEdit, onSetRole, onResetPassword, onIdentities, onDelete }: UsersTableProps) {
  const manageMenu = (u: DashboardUser) =>
    canManage ? (
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
          <Settings2 /> Manage
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onClick={() => onEdit(u)}>
            Name, username &amp; avatar
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Set role</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {(["viewer", "operator", "admin"] as const).map((role) => (
                <DropdownMenuItem key={role} onClick={() => onSetRole(u, role)}>
                  {role}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onClick={() => onResetPassword(u)}>
            Reset password
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onIdentities(u)}>
            Linked OIDC identities
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => onDelete(u)}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : (
      <span className="text-sm text-muted-foreground">View only</span>
    );

  if (isNarrow) {
    if (loading && items.length === 0) return <p className="text-sm text-muted-foreground">Loading users…</p>;
    if (items.length === 0) return <p className="text-sm text-muted-foreground">No users.</p>;
    return (
      <div className="flex flex-col gap-4">
        {items.map((u) => (
          <div key={u.id} className="flex flex-col gap-3 rounded-xl bg-card px-5 py-4">
            <div className="flex items-center gap-3">
              <DashboardUserAvatar
                username={u.username}
                displayName={u.display_name}
                displayIcon={u.display_icon}
                size={40}
              />
              <div className="min-w-0">
                <div className="truncate font-heading text-base font-medium">
                  {u.display_name?.trim() || u.username}
                </div>
                <div className="text-sm text-muted-foreground">@{u.username}</div>
                <RoleText role={u.role} />
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Created {new Date(u.created_at).toLocaleString()}
            </p>
            <div>{manageMenu(u)}</div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-card px-2 py-1">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-13 px-3"><span className="sr-only">Avatar</span></TableHead>
            <TableHead className="px-3">Name</TableHead>
            <TableHead className="px-3">Username</TableHead>
            <TableHead className="px-3">Role</TableHead>
            <TableHead className="px-3">Created</TableHead>
            <TableHead className="px-3"><span className="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-2"><Spinner /> Loading users</span>
              </TableCell>
            </TableRow>
          ) : items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                No users.
              </TableCell>
            </TableRow>
          ) : (
            items.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="px-3 py-3.5">
                  <DashboardUserAvatar
                    username={u.username}
                    displayName={u.display_name}
                    displayIcon={u.display_icon}
                    size={32}
                  />
                </TableCell>
                <TableCell className="px-3 py-3.5">{u.display_name?.trim() || "—"}</TableCell>
                <TableCell className="px-3 py-3.5">{u.username}</TableCell>
                <TableCell className="px-3 py-3.5"><RoleText role={u.role} /></TableCell>
                <TableCell className="px-3 py-3.5">{new Date(u.created_at).toLocaleString()}</TableCell>
                <TableCell className="px-3 py-3.5">{manageMenu(u)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
