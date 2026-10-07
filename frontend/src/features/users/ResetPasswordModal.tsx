import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

interface ResetPasswordModalProps {
  visible: boolean;
  onDismiss: () => void;
  username: string;
  onConfirm: (password: string) => Promise<void>;
}

export function ResetPasswordModal({
  visible,
  onDismiss,
  username,
  onConfirm,
}: ResetPasswordModalProps) {
  const [pwValue, setPwValue] = useState("");
  const [loading, setLoading] = useState(false);

  const [prevVisible, setPrevVisible] = useState(false);

  if (visible !== prevVisible) {
    setPrevVisible(visible);
    if (visible) {
      setPwValue("");
    }
  }

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await onConfirm(pwValue);
      onDismiss();
    } catch {
      // Handled by parent
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={visible} onOpenChange={(open) => !open && !loading && onDismiss()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reset password: {username}</DialogTitle>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="reset-password">New password</FieldLabel>
          <Input
            id="reset-password"
            type="password"
            value={pwValue}
            onChange={(event) => setPwValue(event.target.value)}
            disabled={loading}
            autoComplete="new-password"
            className="h-9"
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onDismiss} disabled={loading}>
            Cancel
          </Button>
          <Button disabled={pwValue.length < 6 || loading} onClick={() => void handleConfirm()}>
            {loading && <Spinner />} Set password
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
