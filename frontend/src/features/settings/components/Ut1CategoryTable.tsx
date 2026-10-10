import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@vantyr/ui/components/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@vantyr/ui/components/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { Spinner } from "@vantyr/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vantyr/ui/components/table";
import { Switch } from "@/components/common/SettingsSwitch";
import {
  filterCategories,
  groupSelectOptions,
  groupSelectValue,
  humanize,
  type CategoryDraft,
  type Ut1Cat,
} from "../lib/categoryDraft";

/** The "UT1 categories" section: search plus one editable row per category. */
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
    <div className="rounded-lg bg-muted/50 px-3.5 py-3">
      <div className="mb-3">
        <h3 className="font-heading text-base font-medium">
          UT1 categories{" "}
          <span className="font-mono text-sm font-normal text-muted-foreground tabular-nums">({ut1Cats.length})</span>
        </h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Each row is a UT1 category. Edit the label (display name), toggle it on/off, or assign it to a custom group.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <InputGroup className="h-9 bg-background/60">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search categories"
              placeholder="Search by UT1 key, label or group…"
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
            <span className="text-xs text-muted-foreground">
              {filtered.length} of {ut1Cats.length} shown
            </span>
          )}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-3">UT1 key</TableHead>
              <TableHead className="px-3">Display label</TableHead>
              <TableHead className="px-3">Description</TableHead>
              <TableHead className="px-3">Group</TableHead>
              <TableHead className="px-3">Enabled</TableHead>
              <TableHead className="w-10 px-3"><span className="sr-only">Unsaved</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-2"><Spinner /> Loading categories…</span>
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {filterText ? "No categories match." : "No UT1 categories loaded yet — download the list first."}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="px-3 py-3.5 font-mono text-xs">{r.key}</TableCell>
                  <TableCell className="px-3 py-3.5">
                    <Input
                      value={r.label}
                      onChange={(event) => onPatch(r.key, { label: event.target.value })}
                      placeholder={humanize(r.key)}
                      aria-label={`Display label for ${r.key}`}
                      className="h-9 min-w-36 bg-background/60"
                    />
                  </TableCell>
                  <TableCell className="px-3 py-3.5">
                    <Input
                      value={r.description}
                      onChange={(event) => onPatch(r.key, { description: event.target.value })}
                      placeholder="Optional description"
                      aria-label={`Description for ${r.key}`}
                      className="h-9 min-w-36 bg-background/60"
                    />
                  </TableCell>
                  <TableCell className="px-3 py-3.5">
                    <Select value={groupSelectValue(r, groupOptions)} onValueChange={(value) => onAssignGroup(r.key, value)}>
                      <SelectTrigger aria-label={`Group for ${r.key}`} className="h-9 min-w-36 bg-background/60">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {groupOptions.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="px-3 py-3.5">
                    <Switch
                      checked={r.enabled}
                      onCheckedChange={(checked) => onPatch(r.key, { enabled: checked })}
                      aria-label={`Enabled for ${r.key}`}
                    />
                  </TableCell>
                  <TableCell className="px-3 py-3.5">
                    {r.dirty ? (
                      <span className="text-base leading-none text-primary" aria-label="Unsaved changes">•</span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
