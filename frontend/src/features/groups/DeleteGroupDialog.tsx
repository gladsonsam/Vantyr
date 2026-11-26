import { useState } from "react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@vantyr/ui/components/alert-dialog";
import { Spinner } from "@vantyr/ui/components/spinner";
import type { AgentGroup } from "@/api/types";
import { plural } from "./groupSummary";

interface DeleteGroupDialogProps {
  /** The group to delete; the dialog is closed while this is null. */
  group: AgentGroup | null;
  /** Alert rules that target the group, when the rule list has loaded. */
  ruleCount: number | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

/** Group removal changes inherited policy, so the consequences are stated before the confirm button. */
export function DeleteGroupDialog({
  group,
  ruleCount,
  pending,
  error,
  onClose,
  onConfirm,
}: DeleteGroupDialogProps) {
  // Keep the last group's text while the dialog animates closed.
  const [last, setLast] = useState(group);
  if (group && group !== last) setLast(group);
  const shown = group ?? last;
  const members = shown?.member_count ?? 0;
  return (
    <AlertDialog
      open={group !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{shown?.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {members > 0
              ? `${plural(members, "device")} will stop inheriting rules through this group. `
              : "No devices are in this group. "}
            {ruleCount
              ? `${plural(ruleCount, "alert rule")} that target${ruleCount === 1 ? "s" : ""} it will lose that target. `
              : "Any rule that targets it loses that target. "}
            The devices themselves are kept. This can’t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending && <Spinner />} Delete group
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
