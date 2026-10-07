import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { DashboardRole } from "@/lib/types";

const ROLE_OPTIONS: { label: string; value: DashboardRole; description: string }[] = [
  {
    label: "Viewer",
    value: "viewer",
    description: "Read agents, telemetry, activity, and audit log. Cannot use live screen, remote actions, or scripts.",
  },
  {
    label: "Operator",
    value: "operator",
    description:
      "Everything viewers can do, plus live screen, wake/clear history, software inventory refresh, agent icon, and remote scripts (when enabled on the server).",
  },
  {
    label: "Admin",
    value: "admin",
    description:
      "Full control: retention, auto-update policy, local UI passwords, users, agent groups, and alert rules.",
  },
];

interface CreateUserModalProps {
  visible: boolean;
  onDismiss: () => void;
  isNarrow: boolean;
  onCreate: (data: {
    display_name: string;
    username: string;
    password: string;
    role: DashboardRole;
  }) => Promise<void>;
}

export function CreateUserModal({
  visible,
  onDismiss,
  isNarrow,
  onCreate,
}: CreateUserModalProps) {
  const [create, setCreate] = useState<{
    display_name: string;
    username: string;
    password: string;
    role: DashboardRole;
  }>({
    display_name: "",
    username: "",
    password: "",
    role: "viewer",
  });
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    setLoading(true);
    try {
      await onCreate(create);
      setCreate({ display_name: "", username: "", password: "", role: "viewer" });
      onDismiss();
    } catch {
      // Errors should be handled by the parent callback via rejection
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={visible} onOpenChange={(open) => !open && !loading && onDismiss()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create user</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-5">
          <Field>
            <FieldLabel htmlFor="create-display-name">Full name</FieldLabel>
            <Input
              id="create-display-name"
              value={create.display_name}
              onChange={(event) => setCreate((p) => ({ ...p, display_name: event.target.value }))}
              placeholder="e.g. Jane Doe"
              disabled={loading}
              className="h-9"
            />
            <FieldDescription>Optional. Shown in the UI; sign-in still uses username.</FieldDescription>
          </Field>
          <div className={isNarrow ? "grid grid-cols-1 gap-5" : "grid grid-cols-1 gap-5 md:grid-cols-2"}>
            <Field>
              <FieldLabel htmlFor="create-username">Username</FieldLabel>
              <Input
                id="create-username"
                value={create.username}
                onChange={(event) => setCreate((p) => ({ ...p, username: event.target.value }))}
                disabled={loading}
                autoComplete="off"
                className="h-9"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="create-role">Role</FieldLabel>
              <Select
                value={create.role}
                onValueChange={(value) => setCreate((p) => ({ ...p, role: value as DashboardRole }))}
                disabled={loading}
              >
                <SelectTrigger id="create-role" className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                {ROLE_OPTIONS.find((o) => o.value === create.role)?.description ?? ""}
              </FieldDescription>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="create-password">Temporary password</FieldLabel>
            <Input
              id="create-password"
              type="password"
              value={create.password}
              onChange={(event) => setCreate((p) => ({ ...p, password: event.target.value }))}
              disabled={loading}
              autoComplete="new-password"
              className="h-9"
            />
            <FieldDescription>Min 6 characters. User can change later (reset again if needed).</FieldDescription>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onDismiss} disabled={loading}>
            Cancel
          </Button>
          <Button
            disabled={!create.username.trim() || create.password.length < 6 || loading}
            onClick={() => void handleCreate()}
          >
            {loading && <Spinner />} Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
