import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Field, FieldLabel } from "@vantyr/ui/components/field";
import { Input } from "@vantyr/ui/components/input";
import { Switch } from "@/components/common/SettingsSwitch";
import type { CategoryDraft, CustomGroup } from "../lib/categoryDraft";

/** The "Custom groups" section of the category manager: add, rename, hide and delete groups. */
export function CustomGroupsPanel({ groups, ut1Cats, onAdd, onPatch, onDelete }: {
  groups: CustomGroup[];
  ut1Cats: CategoryDraft["ut1Cats"];
  onAdd: (label: string) => void;
  onPatch: (index: number, patch: Partial<CustomGroup>) => void;
  onDelete: (index: number) => void;
}) {
  const [newGroupLabel, setNewGroupLabel] = useState("");
  const liveGroups = groups.filter((g) => !g.deleted);

  const add = () => {
    if (!newGroupLabel.trim()) return;
    onAdd(newGroupLabel);
    setNewGroupLabel("");
  };

  return (
    <div className="rounded-lg bg-muted/50 px-3.5 py-3">
      <div className="mb-1 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-heading text-base font-medium">Custom groups</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Create named groups to roll up multiple UT1 categories into one. Analytics will show the group name by default.
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input
          value={newGroupLabel}
          onChange={(event) => setNewGroupLabel(event.target.value)}
          placeholder="Group label (e.g. Entertainment)"
          onKeyDown={(event) => { if (event.key === "Enter") add(); }}
          className="h-9 bg-background/60"
          aria-label="New group label"
        />
        <Button disabled={!newGroupLabel.trim()} onClick={add}>
          <Plus /> Add group
        </Button>
      </div>
      {liveGroups.length === 0 ? (
        <p className="pt-3 text-sm text-muted-foreground">
          No custom groups yet. Create one above, then assign UT1 categories to it in the table below.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 pt-3 sm:grid-cols-2 xl:grid-cols-3">
          {groups.map((g, idx) =>
            g.deleted ? null : (
              <div key={g.isNew ? `new:${g.key}` : g.id} className="flex flex-col gap-3 rounded-lg bg-background/50 px-3.5 py-3">
                <Field>
                  <FieldLabel>Label</FieldLabel>
                  <Input
                    value={g.label}
                    onChange={(event) => onPatch(idx, { label: event.target.value })}
                    className="h-9"
                    aria-label={`Group label for ${g.key}`}
                  />
                </Field>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={g.hidden}
                      onCheckedChange={(checked) => onPatch(idx, { hidden: checked })}
                      aria-label={`Hidden in analytics for ${g.label}`}
                    />
                    <span className="text-xs text-muted-foreground">Hidden in analytics</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {g.isNew ? "new" : `${ut1Cats.filter((c) => c.groupId === g.id).length} members`}
                  </span>
                  <Button variant="ghost" size="icon-sm" aria-label={`Delete group ${g.label}`} onClick={() => onDelete(idx)}>
                    <X />
                  </Button>
                </div>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
