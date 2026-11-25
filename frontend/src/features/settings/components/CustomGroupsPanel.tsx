import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Input } from "@vantyr/ui/components/input";
import { Switch } from "@/components/common/SettingsSwitch";
import { groupNameProblem, type CategoryDraft, type CustomGroup } from "../lib/categoryDraft";

const memberCount = (n: number) => `${n} ${n === 1 ? "category" : "categories"}`;

/** The "Custom groups" section of the category manager: add, rename, hide and delete groups. */
export function CustomGroupsPanel({ draft, onAdd, onPatch, onDelete }: {
  draft: CategoryDraft;
  onAdd: (label: string) => void;
  onPatch: (index: number, patch: Partial<CustomGroup>) => void;
  onDelete: (index: number) => void;
}) {
  const { groups, ut1Cats } = draft;
  const [newGroupLabel, setNewGroupLabel] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const liveGroups = groups.filter((g) => !g.deleted);

  const add = () => {
    if (!newGroupLabel.trim()) return;
    const issue = groupNameProblem(draft, newGroupLabel);
    setProblem(issue);
    if (issue) return;
    onAdd(newGroupLabel);
    setNewGroupLabel("");
  };

  return (
    <section aria-labelledby="custom-groups-heading" className="rounded-lg bg-muted/50 px-3.5 py-3">
      <h3 id="custom-groups-heading" className="font-heading text-base font-medium">Custom groups</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">
        A group rolls several list categories up under one name in analytics. Deleting a group leaves its categories ungrouped.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input
          value={newGroupLabel}
          onChange={(event) => { setNewGroupLabel(event.target.value); setProblem(null); }}
          placeholder="Group name (e.g. Entertainment)"
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }}
          className="h-9 bg-background/60"
          aria-label="New group name"
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? "new-group-problem" : undefined}
        />
        <Button disabled={!newGroupLabel.trim()} onClick={add}>
          <Plus /> Add group
        </Button>
      </div>
      {problem ? <p id="new-group-problem" role="alert" className="pt-2 text-sm text-destructive">{problem}</p> : null}
      {liveGroups.length === 0 ? (
        <p className="pt-3 text-sm text-muted-foreground">No groups yet. Add one, save, then pick its categories in the list below.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 pt-3 sm:grid-cols-2 xl:grid-cols-3">
          {groups.map((g, idx) =>
            g.deleted ? null : (
              <li key={g.isNew ? `new:${g.key}` : g.id} className="flex flex-col gap-3 rounded-lg bg-background/50 px-3.5 py-3">
                <div className="flex items-center gap-2">
                  <Input
                    value={g.label}
                    onChange={(event) => onPatch(idx, { label: event.target.value })}
                    className="h-9"
                    aria-label={`Name of group ${g.key}`}
                    aria-invalid={g.label.trim() ? undefined : true}
                  />
                  <Button variant="ghost" size="icon-sm" aria-label={`Delete group ${g.label || g.key}`} onClick={() => onDelete(idx)}>
                    <Trash2 />
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={g.hidden}
                    onCheckedChange={(checked) => onPatch(idx, { hidden: checked })}
                    aria-label={`Hide ${g.label || g.key} in analytics`}
                  />
                  <span className="text-sm">Hide in analytics</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {g.isNew
                    ? "Not saved yet. Save to start assigning categories."
                    : memberCount(ut1Cats.filter((c) => c.groupId === g.id).length)}
                </p>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}
