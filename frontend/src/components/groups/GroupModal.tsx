import { useEffect, useState } from "react";
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
import type { AgentGroup } from "@/lib/types";

interface GroupModalProps {
  visible: boolean;
  onDismiss: () => void;
  group: AgentGroup | null; // null for create
  onSave: (data: { name: string; description: string }) => Promise<void>;
}

export function GroupModal({ visible, onDismiss, group, onSave }: GroupModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (visible) {
      setName(group?.name ?? "");
      setDescription(group?.description ?? "");
    }
  }, [visible, group]);

  const handleSave = async () => {
    if (!name.trim()) return;
    setLoading(true);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim(),
      });
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
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <DialogHeader>
            <DialogTitle>{group ? "Rename agent group" : "Create agent group"}</DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="group-name">Name</FieldLabel>
            <Input
              id="group-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={loading}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="group-description">Description</FieldLabel>
            <Input
              id="group-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={loading}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={loading} onClick={onDismiss}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || loading}>
              {loading && <Spinner />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
