import { useMemo, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@vantyr/ui/components/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@vantyr/ui/components/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@vantyr/ui/components/select";
import { Spinner } from "@vantyr/ui/components/spinner";
import { Switch } from "@/components/common/SettingsSwitch";
import { cn } from "@/lib/utils";
import {
  filterCategories,
  groupSelectOptions,
  groupSelectValue,
  humanize,
  type CategoryDraft,
  type Ut1Cat,
} from "../lib/categoryDraft";

/** Shared by the column captions and each row so the columns line up from tablet width up. */
const ROW_GRID = "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 md:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)_10rem_5.5rem] md:items-center";

/** The "List categories" section: search plus one editable row per category. */
export function Ut1CategoryTable({ draft, loading, onPatch, onAssignGroup }: {
  draft: CategoryDraft;
  loading: boolean;
  onPatch: (key: string, patch: Partial<Ut1Cat>) => void;
  onAssignGroup: (key: string, selectValue: string | null) => void;
}) {
  const [filterText, setFilterText] = useState("");
  const { ut1Cats, groups } = draft;
  const groupOptions = useMemo(() => groupSelectOptions(groups), [groups]);
  const filtered = useMemo(() => filterCategories(draft, filterText), [draft, filterText]);

  return (
    <section aria-labelledby="list-categories-heading" className="rounded-lg bg-muted/50 px-3.5 py-3">
      <h3 id="list-categories-heading" className="font-heading text-base font-medium">
        List categories{" "}
        <span className="font-mono text-sm font-normal text-muted-foreground tabular-nums">({ut1Cats.length})</span>
      </h3>
      <p className="mt-0.5 mb-3 text-sm text-muted-foreground">
        Change the name or description shown for a category, put it in a group, or hide it. A hidden category disappears from analytics and URL history.
      </p>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <InputGroup className="h-9 bg-background/60">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search categories"
              placeholder="Search by key, name or group"
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
            />
            {filterText && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setFilterText("")}>
                  <X />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
          {filterText && (
            <span role="status" className="text-xs text-muted-foreground">
              {filtered.length} of {ut1Cats.length} shown
            </span>
          )}
        </div>
        {loading && filtered.length === 0 ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Spinner /> Loading categories…</p>
        ) : filtered.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            {filterText ? `No categories match “${filterText}”.` : "No categories yet. Download the lists first (Data → URL categorization)."}
          </p>
        ) : (
          <div>
            <div aria-hidden="true" className={cn(ROW_GRID, "hidden border-b border-border/50 pb-2 text-xs text-muted-foreground md:grid")}>
              <span>Key</span>
              <span>Name</span>
              <span>Description</span>
              <span>Group</span>
              <span>In analytics</span>
            </div>
            <ul className="divide-y divide-border/50">
              {filtered.map((r) => (
                <CategoryRow key={r.key} row={r} groupOptions={groupOptions} onPatch={onPatch} onAssignGroup={onAssignGroup} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function CategoryRow({ row: r, groupOptions, onPatch, onAssignGroup }: {
  row: Ut1Cat;
  groupOptions: { value: string; label: string }[];
  onPatch: (key: string, patch: Partial<Ut1Cat>) => void;
  onAssignGroup: (key: string, selectValue: string | null) => void;
}) {
  const id = `cat-${r.key}`;
  return (
    <li className={`${ROW_GRID} py-3`}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-xs break-all">{r.key}</span>
        {r.dirty ? <span className="text-xs text-primary">Edited</span> : null}
      </div>
      <div className="flex items-center gap-2 md:order-last">
        <Switch
          checked={r.enabled}
          onCheckedChange={(checked) => onPatch(r.key, { enabled: checked })}
          aria-label={`Show ${r.key} in analytics and URL history`}
        />
        <span className="w-12 text-xs text-muted-foreground">{r.enabled ? "Shown" : "Hidden"}</span>
      </div>
      <RowField id={`${id}-label`} caption="Name">
        <Input
          id={`${id}-label`}
          value={r.label}
          onChange={(event) => onPatch(r.key, { label: event.target.value })}
          placeholder={humanize(r.key)}
          className="h-9 bg-background/60"
        />
      </RowField>
      <RowField id={`${id}-description`} caption="Description">
        <Input
          id={`${id}-description`}
          value={r.description}
          onChange={(event) => onPatch(r.key, { description: event.target.value })}
          placeholder="Optional"
          className="h-9 bg-background/60"
        />
      </RowField>
      <RowField id={`${id}-group`} caption="Group">
        <Select value={groupSelectValue(r, groupOptions)} onValueChange={(value) => onAssignGroup(r.key, value)}>
          <SelectTrigger id={`${id}-group`} className="h-9 w-full bg-background/60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {groupOptions.map((o) => {
              // A group that has not been saved has no id to assign yet.
              const unsaved = o.value.startsWith("new:");
              return (
                <SelectItem key={o.value} value={o.value} disabled={unsaved}>
                  {unsaved ? `${o.label} (save first)` : o.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </RowField>
    </li>
  );
}

/** A labelled control: the caption shows on a phone and becomes a column heading from tablet up. */
function RowField({ id, caption, children }: { id: string; caption: string; children: ReactNode }) {
  return (
    <div className="col-span-2 flex flex-col gap-1 md:col-span-1">
      <label htmlFor={id} className="text-xs text-muted-foreground md:sr-only">{caption}</label>
      {children}
    </div>
  );
}
