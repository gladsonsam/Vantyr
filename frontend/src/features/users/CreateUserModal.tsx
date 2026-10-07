import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { InputField } from "@/components/common/form/fields";
import { FormField } from "@/components/common/form/FormField";
import type { DashboardRole } from "@/api/types";
import { ROLE_OPTIONS } from "./roles";
import { createUserSchema, type CreateUserValues } from "./userSchemas";

interface CreateUserModalProps {
  visible: boolean;
  onDismiss: () => void;
  isNarrow: boolean;
  onCreate: (data: CreateUserValues) => Promise<void>;
}

export function CreateUserModal({ visible, onDismiss, isNarrow, onCreate }: CreateUserModalProps) {
  // The dialog can't be dismissed while the create request is in flight.
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={visible} onOpenChange={(open) => !open && !busy && onDismiss()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create user</DialogTitle>
        </DialogHeader>
        {visible && <CreateUserForm onDismiss={onDismiss} isNarrow={isNarrow} onCreate={onCreate} onBusyChange={setBusy} />}
      </DialogContent>
    </Dialog>
  );
}

function CreateUserForm({ onDismiss, isNarrow, onCreate, onBusyChange }: Omit<CreateUserModalProps, "visible"> & { onBusyChange: (busy: boolean) => void }) {
  const form = useForm<CreateUserValues>({
    resolver: zodResolver(createUserSchema),
    mode: "onChange",
    defaultValues: { display_name: "", username: "", password: "", role: "viewer" },
  });
  const { control } = form;
  const { isValid, isSubmitting } = form.formState;
  const role = useWatch({ control, name: "role" });

  const submit = form.handleSubmit(async (values) => {
    onBusyChange(true);
    try {
      await onCreate(values);
      onDismiss();
    } catch {
      // The parent reports the failure and the dialog stays open for another try.
    } finally {
      onBusyChange(false);
    }
  });

  return (
    <form onSubmit={submit} noValidate className="contents">
      <div className="flex flex-col gap-5">
        <InputField
          control={control}
          name="display_name"
          id="create-display-name"
          label="Full name"
          placeholder="e.g. Jane Doe"
          disabled={isSubmitting}
          className="h-9"
          description="Optional. Shown in the UI; sign-in still uses username."
        />
        <div className={isNarrow ? "grid grid-cols-1 gap-5" : "grid grid-cols-1 gap-5 md:grid-cols-2"}>
          <InputField control={control} name="username" id="create-username" label="Username" disabled={isSubmitting} autoComplete="off" className="h-9" hideError />
          <FormField
            control={control}
            name="role"
            id="create-role"
            label="Role"
            description={ROLE_OPTIONS.find((o) => o.value === role)?.description ?? ""}
          >
            {({ field, id }) => (
              <Select value={field.value} onValueChange={(value) => field.onChange(value as DashboardRole)} disabled={isSubmitting}>
                <SelectTrigger id={id} className="h-9 w-full">
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
            )}
          </FormField>
        </div>
        <InputField
          control={control}
          name="password"
          id="create-password"
          label="Temporary password"
          type="password"
          disabled={isSubmitting}
          autoComplete="new-password"
          className="h-9"
          description="Min 6 characters. User can change later (reset again if needed)."
          hideError
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDismiss} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={!isValid || isSubmitting}>
          {isSubmitting && <Spinner />} Create
        </Button>
      </DialogFooter>
    </form>
  );
}
