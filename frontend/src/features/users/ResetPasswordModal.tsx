import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { InputField } from "@/components/common/form/fields";
import { resetPasswordSchema, type ResetPasswordValues } from "./userSchemas";

interface ResetPasswordModalProps {
  visible: boolean;
  onDismiss: () => void;
  username: string;
  onConfirm: (password: string) => Promise<void>;
}

export function ResetPasswordModal({ visible, onDismiss, username, onConfirm }: ResetPasswordModalProps) {
  // The dialog can't be dismissed while the request is in flight.
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={visible} onOpenChange={(open) => !open && !busy && onDismiss()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reset password: {username}</DialogTitle>
        </DialogHeader>
        {visible && <ResetPasswordForm onDismiss={onDismiss} onConfirm={onConfirm} onBusyChange={setBusy} />}
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordForm({ onDismiss, onConfirm, onBusyChange }: Pick<ResetPasswordModalProps, "onDismiss" | "onConfirm"> & { onBusyChange: (busy: boolean) => void }) {
  const form = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    mode: "onChange",
    defaultValues: { password: "" },
  });
  const { isValid, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async ({ password }) => {
    onBusyChange(true);
    try {
      await onConfirm(password);
      onDismiss();
    } catch {
      // The parent reports the failure.
    } finally {
      onBusyChange(false);
    }
  });

  return (
    <form onSubmit={submit} noValidate className="contents">
      <InputField
        control={form.control}
        name="password"
        id="reset-password"
        label="New password"
        type="password"
        disabled={isSubmitting}
        autoComplete="new-password"
        className="h-9"
        hideError
      />
      <DialogFooter>
        <Button variant="outline" onClick={onDismiss} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={!isValid || isSubmitting}>
          {isSubmitting && <Spinner />} Set password
        </Button>
      </DialogFooter>
    </form>
  );
}
