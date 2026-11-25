import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@vantyr/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vantyr/ui/components/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { Spinner } from "@vantyr/ui/components/spinner";
import { InputField } from "@/components/common/form/fields";
import { FormField } from "@/components/common/form/FormField";
import type { DashboardRole } from "@/api/types";
import { ROLE_OPTIONS } from "./roles";
import { DialogError } from "./UserDialogParts";
import { messageOr } from "./messageOr";
import { createUserSchema, type CreateUserValues } from "./userSchemas";

interface CreateUserModalProps {
  visible: boolean;
  onDismiss: () => void;
  /** Where focus goes when the dialog closes. */
  finalFocus?: () => HTMLElement | null;
  /** Rejects with why the account could not be created; the dialog shows it and stays open. */
  onCreate: (data: CreateUserValues) => Promise<void>;
}

export function CreateUserModal({ visible, onDismiss, finalFocus, onCreate }: CreateUserModalProps) {
  // The dialog can't be dismissed while the create request is in flight.
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={visible} onOpenChange={(open) => !open && !busy && onDismiss()}>
      <DialogContent finalFocus={finalFocus} className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create user</DialogTitle>
          <DialogDescription>They sign in with this username and a temporary password.</DialogDescription>
        </DialogHeader>
        {visible && <CreateUserForm onDismiss={onDismiss} onCreate={onCreate} onBusyChange={setBusy} />}
      </DialogContent>
    </Dialog>
  );
}

function CreateUserForm({ onDismiss, onCreate, onBusyChange }: Omit<CreateUserModalProps, "visible"> & { onBusyChange: (busy: boolean) => void }) {
  const form = useForm<CreateUserValues>({
    resolver: zodResolver(createUserSchema),
    mode: "onChange",
    defaultValues: { display_name: "", username: "", password: "", role: "viewer" },
  });
  const { control } = form;
  const { isValid, isSubmitting } = form.formState;
  const role = useWatch({ control, name: "role" });
  const [error, setError] = useState<string | null>(null);

  const submit = form.handleSubmit(async (values) => {
    onBusyChange(true);
    setError(null);
    try {
      await onCreate(values);
      onDismiss();
    } catch (e: unknown) {
      // The dialog stays open so the form can be corrected and sent again.
      setError(messageOr(e, "Failed to create user"));
    } finally {
      onBusyChange(false);
    }
  });

  return (
    <form onSubmit={submit} noValidate className="contents">
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <InputField control={control} name="username" id="create-username" label="Username" disabled={isSubmitting} autoComplete="off" className="h-9" />
          <InputField
            control={control}
            name="display_name"
            id="create-display-name"
            label="Full name"
            placeholder="Optional"
            disabled={isSubmitting}
            autoComplete="off"
            className="h-9"
          />
        </div>
        <FormField control={control} name="role" id="create-role" label="Role">
          {({ field, id }) => (
            <>
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
              <p className="text-xs text-muted-foreground">{ROLE_OPTIONS.find((o) => o.value === role)?.description}</p>
            </>
          )}
        </FormField>
        <InputField
          control={control}
          name="password"
          id="create-password"
          label="Temporary password"
          type="password"
          disabled={isSubmitting}
          autoComplete="new-password"
          className="h-9"
          placeholder="At least 6 characters"
          hideError
        />
        <DialogError prefix="Couldn't create the user" message={error} />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDismiss} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={!isValid || isSubmitting}>
          {isSubmitting && <Spinner />} Create user
        </Button>
      </DialogFooter>
    </form>
  );
}
