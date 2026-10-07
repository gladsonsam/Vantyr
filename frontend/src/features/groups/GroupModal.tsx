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
import type { AgentGroup } from "@/api/types";
import { groupSchema, type GroupValues } from "./groupSchemas";

interface GroupModalProps {
  visible: boolean;
  onDismiss: () => void;
  group: AgentGroup | null; // null for create
  onSave: (data: GroupValues) => Promise<void>;
}

export function GroupModal({ visible, onDismiss, group, onSave }: GroupModalProps) {
  // The dialog can't be dismissed while the save request is in flight.
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={visible} onOpenChange={(open) => !open && !busy && onDismiss()}>
      <DialogContent className="sm:max-w-md">
        {visible && <GroupForm group={group} onDismiss={onDismiss} onSave={onSave} onBusyChange={setBusy} />}
      </DialogContent>
    </Dialog>
  );
}

function GroupForm({ group, onDismiss, onSave, onBusyChange }: Omit<GroupModalProps, "visible"> & { onBusyChange: (busy: boolean) => void }) {
  const form = useForm<GroupValues>({
    resolver: zodResolver(groupSchema),
    mode: "onChange",
    defaultValues: { name: group?.name ?? "", description: group?.description ?? "" },
  });
  const { isValid, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async (values) => {
    onBusyChange(true);
    try {
      await onSave(values);
      onDismiss();
    } catch {
      // Handled by parent
    } finally {
      onBusyChange(false);
    }
  });

  return (
    <form className="grid gap-4" onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>{group ? "Rename agent group" : "Create agent group"}</DialogTitle>
      </DialogHeader>
      <InputField control={form.control} name="name" id="group-name" label="Name" autoFocus disabled={isSubmitting} hideError />
      <InputField control={form.control} name="description" id="group-description" label="Description" disabled={isSubmitting} />
      <DialogFooter>
        <Button type="button" variant="outline" disabled={isSubmitting} onClick={onDismiss}>
          Cancel
        </Button>
        <Button type="submit" disabled={!isValid || isSubmitting}>
          {isSubmitting && <Spinner />} Save
        </Button>
      </DialogFooter>
    </form>
  );
}
