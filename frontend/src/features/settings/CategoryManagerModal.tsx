/**
 * CategoryManagerModal
 *
 * One-stop shop for managing how UT1 categories appear in the UI:
 *   - Rename any UT1 category (persists across UT1 updates via url_category_labels)
 *   - Enable / disable a category entirely (hides from analytics + URL history)
 *   - Create custom "groups" (url_custom_categories) and drag any UT1 categories into them
 *     so many-to-one rollup collapses them in analytics
 *
 * All changes are staged locally and saved in one "Save all" click.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/api";
import { Switch } from "@/components/common/SettingsSwitch";

// ─── types ────────────────────────────────────────────────────────────────────

interface Ut1Cat {
  key: string;
  label: string;          // current display label (possibly edited locally)
  description: string;
  enabled: boolean;
  groupId: number | null; // custom group this UT1 key belongs to (null = ungrouped)
  dirty: boolean;         // has the user changed anything?
}

interface CustomGroup {
  id: number | null;      // null = not yet created on server
  key: string;
  label: string;
  hidden: boolean;
  isNew: boolean;
  deleted: boolean;
}

interface Props {
  visible: boolean;
  onDismiss: () => void;
}

const NO_GROUP = "__none__";

function humanize(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ─── component ───────────────────────────────────────────────────────────────

export function CategoryManagerModal({ visible, onDismiss }: Props) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [ut1Cats, setUt1Cats] = useState<Ut1Cat[]>([]);
  const [groups, setGroups] = useState<CustomGroup[]>([]);

  // create-group form
  const [newGroupLabel, setNewGroupLabel] = useState("");
  const [newGroupKey, setNewGroupKey] = useState("");

  // filter
  const [filterText, setFilterText] = useState("");

  // ── load ────────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [catRes, grpRes] = await Promise.all([
        api.urlCategorizationCategoriesGet(),
        api.urlCustomCategoriesList(),
      ]);

      // Build a map of ut1_key → custom group id
      const keyToGroup = new Map<string, number>();
      for (const g of grpRes.rows ?? []) {
        for (const k of g.ut1_keys ?? []) {
          keyToGroup.set(k, g.id);
        }
      }

      setUt1Cats(
        (catRes.categories ?? []).map((c) => ({
          key: c.key,
          label: c.label?.trim() || humanize(c.key),
          description: c.description ?? "",
          enabled: c.enabled,
          groupId: keyToGroup.get(c.key) ?? null,
          dirty: false,
        }))
      );

      setGroups(
        (grpRes.rows ?? []).map((g) => ({
          id: g.id,
          key: g.key,
          label: g.label_en,
          hidden: g.hidden,
          isNew: false,
          deleted: false,
        }))
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    setFilterText("");
    setSaved(false);
    void load();
  }, [visible, load]);

  // ── helpers ──────────────────────────────────────────────────────────────────

  const updateCat = (key: string, patch: Partial<Ut1Cat>) => {
    setUt1Cats((prev) =>
      prev.map((c) => (c.key === key ? { ...c, ...patch, dirty: true } : c))
    );
  };

  const updateGroup = (idx: number, patch: Partial<CustomGroup>) => {
    setGroups((prev) => prev.map((g, i) => (i === idx ? { ...g, ...patch } : g)));
  };

  const addGroup = () => {
    const label = newGroupLabel.trim();
    const key = newGroupKey.trim() || label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    if (!label || !key) return;
    setGroups((prev) => [...prev, { id: null, key, label, hidden: false, isNew: true, deleted: false }]);
    setNewGroupLabel("");
    setNewGroupKey("");
  };

  const deleteGroup = (idx: number) => {
    const g = groups[idx];
    if (g.isNew) {
      // remove entirely and unassign its members
      setGroups((prev) => prev.filter((_, i) => i !== idx));
      // isNew groups have id=null; can't unassign by id; leave groupId values as-is
      return;
    }
    setGroups((prev) => prev.map((g2, i) => (i === idx ? { ...g2, deleted: true } : g2)));
    // unassign any UT1 cats that were in this group
    if (g.id !== null) {
      setUt1Cats((prev) => prev.map((c) => (c.groupId === g.id ? { ...c, groupId: null, dirty: true } : c)));
    }
  };

  const groupOptions = useMemo(() => {
    const opts = groups
      .filter((g) => !g.deleted)
      .map((g) => ({
        value: String(g.id ?? `new:${g.key}`),
        label: g.label,
      }));
    return [{ value: NO_GROUP, label: "— No group —" }, ...opts];
  }, [groups]);

  const groupLabelById = useCallback((id: number | null): string => {
    if (id === null) return "";
    const g = groups.find((x) => x.id === id && !x.deleted);
    return g ? g.label : "";
  }, [groups]);

  // ── save ────────────────────────────────────────────────────────────────────

  const saveAll = async () => {
    setSaving(true);
    setError(null);
    try {
      // 1. Save UT1 category labels + enabled flags (only dirty rows, but send all to be safe)
      await api.urlCategorizationCategoriesPut({
        categories: ut1Cats.map((c) => ({
          key: c.key,
          enabled: c.enabled,
          label: c.label,
          description: c.description,
        })),
      });

      // 2. Handle custom groups:
      //    a) Create new groups and get their ids
      const groupIdMap = new Map<string, number>(); // key → real id
      for (const g of groups) {
        if (g.deleted) continue;
        if (g.isNew) {
          const res = await api.urlCustomCategoriesCreate({
            key: g.key,
            label_en: g.label,
            hidden: g.hidden,
          });
          groupIdMap.set(g.key, res.id);
        } else if (g.id !== null) {
          await api.urlCustomCategoriesUpdate(g.id, {
            label_en: g.label,
            hidden: g.hidden,
          });
          groupIdMap.set(g.key, g.id);
        }
      }

      //    b) Delete removed groups
      for (const g of groups) {
        if (g.deleted && g.id !== null) {
          await api.urlCustomCategoriesDelete(g.id).catch(() => {});
        }
      }

      //    c) Build members list per group and save
      const membersByGroupKey = new Map<string, string[]>();
      for (const c of ut1Cats) {
        if (c.groupId === null) continue;
        const g = groups.find((x) => x.id === c.groupId && !x.deleted);
        if (!g) continue;
        const realId = groupIdMap.get(g.key) ?? g.id;
        if (realId === null) continue;
        const gKey = g.key;
        if (!membersByGroupKey.has(gKey)) membersByGroupKey.set(gKey, []);
        membersByGroupKey.get(gKey)!.push(c.key);
      }

      // Save members for all non-deleted groups
      for (const g of groups.filter((x) => !x.deleted)) {
        const realId = g.isNew ? groupIdMap.get(g.key) : g.id;
        if (!realId) continue;
        const members = membersByGroupKey.get(g.key) ?? [];
        await api.urlCustomCategoriesPutMembers(realId, { ut1_keys: members });
      }

      setSaved(true);
      // Tell other tabs (analytics/url history) to refresh their view.
      window.dispatchEvent(new CustomEvent("vantyr.urlCategoriesChanged"));
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  // ── filtered categories ───────────────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = filterText.toLowerCase();
    if (!q) return ut1Cats;
    return ut1Cats.filter(
      (c) =>
        c.key.toLowerCase().includes(q) ||
        c.label.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        groupLabelById(c.groupId).toLowerCase().includes(q)
    );
  }, [ut1Cats, filterText, groupLabelById]);

  const dirtyCount = ut1Cats.filter((c) => c.dirty).length;
  const groupChanges = groups.filter((g) => g.isNew || g.deleted).length;
  const hasChanges = dirtyCount > 0 || groupChanges > 0;
  const liveGroups = groups.filter((g) => !g.deleted);

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <Dialog open={visible} onOpenChange={(open) => !open && !saving && onDismiss()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Manage categories</DialogTitle>
          <DialogDescription>
            Rename categories, enable/disable them, or group multiple UT1 categories into a single display bucket. Changes survive UT1 list updates.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {/* ── Custom groups ─────────────────────────────────────────────── */}
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
                onKeyDown={(event) => { if (event.key === "Enter") addGroup(); }}
                className="h-9 bg-background/60"
                aria-label="New group label"
              />
              <Button
                disabled={!newGroupLabel.trim()}
                onClick={addGroup}
              >
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
                          onChange={(event) => updateGroup(idx, { label: event.target.value })}
                          className="h-9"
                          aria-label={`Group label for ${g.key}`}
                        />
                      </Field>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={g.hidden}
                            onCheckedChange={(checked) => updateGroup(idx, { hidden: checked })}
                            aria-label={`Hidden in analytics for ${g.label}`}
                          />
                          <span className="text-xs text-muted-foreground">Hidden in analytics</span>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {g.isNew ? "new" : `${ut1Cats.filter((c) => c.groupId === g.id).length} members`}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete group ${g.label}`}
                          onClick={() => deleteGroup(idx)}
                        >
                          <X />
                        </Button>
                      </div>
                    </div>
                  )
                )}
              </div>
            )}
          </div>

          {/* ── UT1 categories table ──────────────────────────────────────── */}
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
                    filtered.map((r) => {
                      const groupValue = r.groupId !== null ? String(r.groupId) : NO_GROUP;
                      return (
                        <TableRow key={r.key}>
                          <TableCell className="px-3 py-3.5 font-mono text-xs">{r.key}</TableCell>
                          <TableCell className="px-3 py-3.5">
                            <Input
                              value={r.label}
                              onChange={(event) => updateCat(r.key, { label: event.target.value })}
                              placeholder={humanize(r.key)}
                              aria-label={`Display label for ${r.key}`}
                              className="h-9 min-w-36 bg-background/60"
                            />
                          </TableCell>
                          <TableCell className="px-3 py-3.5">
                            <Input
                              value={r.description}
                              onChange={(event) => updateCat(r.key, { description: event.target.value })}
                              placeholder="Optional description"
                              aria-label={`Description for ${r.key}`}
                              className="h-9 min-w-36 bg-background/60"
                            />
                          </TableCell>
                          <TableCell className="px-3 py-3.5">
                            <Select
                              value={groupOptions.some((o) => o.value === groupValue) ? groupValue : NO_GROUP}
                              onValueChange={(value) => {
                                if (value === null || value === NO_GROUP) {
                                  updateCat(r.key, { groupId: null });
                                } else if (value.startsWith("new:")) {
                                  // New groups have no server id yet; match by key.
                                  const key = value.slice("new:".length);
                                  const g = groups.find((x) => x.isNew && x.key === key && !x.deleted);
                                  if (g?.id !== null && g?.id !== undefined) {
                                    updateCat(r.key, { groupId: g.id });
                                  }
                                } else {
                                  const numVal = Number(value);
                                  if (!Number.isNaN(numVal)) {
                                    updateCat(r.key, { groupId: numVal });
                                  }
                                }
                              }}
                            >
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
                              onCheckedChange={(checked) => updateCat(r.key, { enabled: checked })}
                              aria-label={`Enabled for ${r.key}`}
                            />
                          </TableCell>
                          <TableCell className="px-3 py-3.5">
                            {r.dirty ? (
                              <span className="text-base leading-none text-primary" aria-label="Unsaved changes">•</span>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>

        <DialogFooter>
          {saved && !hasChanges ? (
            <span className="mr-auto text-sm text-success">Saved.</span>
          ) : null}
          <Button variant="outline" onClick={onDismiss} disabled={saving}>
            Close
          </Button>
          <Button
            disabled={(!hasChanges && !saving) || saving}
            onClick={() => void saveAll()}
          >
            {saving && <Spinner />} Save all changes{hasChanges ? ` (${dirtyCount + groupChanges} pending)` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
