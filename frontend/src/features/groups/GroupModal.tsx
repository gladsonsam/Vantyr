import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vantyr/ui/components/dialog";
import { Spinner } from "@vantyr/ui/components/spinner";
import { InputField } from "@/components/common/form/fields";
import type { AgentGroup } from "@/api/types";
import { groupSchema, type GroupValues } from "./groupSchemas";
import { messageOf } from "./groupSummary";

interface GroupModalProps {
  visible: boolean;
  onDismiss: () => void;
  group: AgentGroup | null; // null for create
  /** Rejecting keeps the dialog open and shows the failure inside it. */
  onSave: (data: GroupValues) => Promise<void>;
}

export function GroupModal({ visible, onDismiss, group, onSave }: GroupModalProps) {
  // The dialog can't be dismissed while the save request is in flight.
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={visible} onOpenChange={(open) => !open && !busy && onDismiss()}>
      <DialogContent className="sm:max-w-md">
        {visible && (
          <GroupForm group={group} onDismiss={onDismiss} onSave={onSave} onBusyChange={setBusy} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function GroupForm({
  group,
  onDismiss,
  onSave,
  onBusyChange,
}: Omit<GroupModalProps, "visible"> & { onBusyChange: (busy: boolean) => void }) {
  const form = useForm<GroupValues>({
    resolver: zodResolver(groupSchema),
    mode: "onChange",
    defaultValues: { name: group?.name ?? "", description: group?.description ?? "" },
  });
  const { isValid, isSubmitting } = form.formState;
  const [error, setError] = useState<string | null>(null);

  const submit = form.handleSubmit(async (values) => {
    setError(null);
    onBusyChange(true);
    try {
      await onSave(values);
      onDismiss();
    } catch (e: unknown) {
      setError(messageOf(e));
    } finally {
      onBusyChange(false);
    }
  });

  return (
    <form className="grid gap-4" onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>{group ? "Edit group" : "Create group"}</DialogTitle>
      </DialogHeader>
      <InputField
        control={form.control}
        name="name"
        id="group-name"
        label="Name"
        placeholder="Front office"
        autoComplete="off"
        disabled={isSubmitting}
      />
      <InputField
        control={form.control}
        name="description"
        id="group-description"
        label="Description"
        description="Optional. Shown on the group list so others know what it is for."
        placeholder="Reception and accounts PCs"
        autoComplete="off"
        disabled={isSubmitting}
      />
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={isSubmitting} onClick={onDismiss}>
          Cancel
        </Button>
        <Button type="submit" disabled={!isValid || isSubmitting}>
          {isSubmitting && <Spinner />} {group ? "Save changes" : "Create group"}
        </Button>
      </DialogFooter>
    </form>
  );
}
