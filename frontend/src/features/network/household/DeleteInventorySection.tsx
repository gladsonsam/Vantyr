import { useState } from "react";
import { Trash2 } from "lucide-react";
import { errorText } from "@/api";
import { useDeleteInventoryMutation } from "@/api/queries/network";
import type { NetworkInventoryDeleteKind } from "@/api/types";
import { HelpTip } from "@/components/common/HelpTip";
import { HoldAction } from "@/features/network/gateways/HoldAction";

export const DELETE_COPY =
  "Deletes this inventory record only. It does not end sessions, revoke worker credentials or establish coverage.";

/**
 * Hold-to-delete inside an edit dialog. Deletion is conservative: the server answers 409 with the
 * reasons while anything still references the row, and that text is shown as is, with the dialog
 * left open. On success the lists refresh and the row (and this dialog) goes away.
 */
export function DeleteInventorySection({
  household,
  kind,
  id,
  noun,
  blockedHelp,
}: {
  household: string;
  kind: NetworkInventoryDeleteKind;
  id: string;
  noun: string;
  /** When set, delete is disabled and this explains why on demand. */
  blockedHelp?: string;
}) {
  const remove = useDeleteInventoryMutation(household, kind);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-3 border-t border-border/50 pt-4">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        Delete {noun}
        {blockedHelp ? <HelpTip label={`Why ${noun} can’t be deleted yet`}>{blockedHelp}</HelpTip> : null}
      </div>
      <p className="text-sm text-muted-foreground">{DELETE_COPY}</p>
      <HoldAction
        icon={<Trash2 className="size-4" />}
        ariaLabel={`Hold to delete ${noun}`}
        doneLabel="Deleted"
        disabled={remove.isPending || Boolean(blockedHelp)}
        onHold={() => {
          setError(null);
          remove.mutate(id, { onError: (e) => setError(errorText(e)) });
        }}
      >
        Hold to delete
      </HoldAction>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
