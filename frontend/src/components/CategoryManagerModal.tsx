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
import { Alert, Box, Button, ColumnLayout, Container, Header, Input, Modal, ButtonDropdown, SpaceBetween, Table, TextFilter, Toggle, Badge } from "./ui/console";
import { api } from "../lib/api";

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

  const load = async () => {
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
  };

  useEffect(() => {
    if (!visible) return;
    setFilterText("");
    setSaved(false);
    void load();
  }, [visible]);

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
      // Also handle ut1Cats that refer to new groups (id=null matched by key)
      for (const c of ut1Cats) {
        if (c.groupId !== null) continue; // handled above
        // groupId is null after user assigned a new group
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
  const hasChanges = dirtyCount > 0 || groups.some((g) => g.isNew || g.deleted);

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      size="max"
      header={
        <Header
          description="Rename categories, enable/disable them, or group multiple UT1 categories into a single display bucket. Changes survive UT1 list updates."
        >
          Manage categories
        </Header>
      }
      footer={
        <SpaceBetween direction="horizontal" size="xs">
          {saved && !hasChanges ? (
            <Box color="text-status-success">Saved.</Box>
          ) : null}
          <Button variant="link" onClick={onDismiss} disabled={saving}>
            Close
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={!hasChanges && !saving}
            onClick={() => void saveAll()}
          >
            Save all changes{hasChanges ? ` (${dirtyCount + groups.filter((g) => g.isNew || g.deleted).length} pending)` : ""}
          </Button>
        </SpaceBetween>
      }
    >
      <SpaceBetween size="l">
        {error ? (
          <Alert type="error" dismissible onDismiss={() => setError(null)}>
            {error}
          </Alert>
        ) : null}

        {/* ── Custom groups ─────────────────────────────────────────────── */}
        <Container
          header={
            <Header
              variant="h2"
              description="Create named groups to roll up multiple UT1 categories into one. Analytics will show the group name by default."
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Input
                    value={newGroupLabel}
                    onChange={({ detail }) => setNewGroupLabel(detail.value)}
                    placeholder="Group label (e.g. Entertainment)"
                    onKeyDown={({ detail }) => { if (detail.key === "Enter") addGroup(); }}
                  />
                  <Button
                    variant="primary"
                    disabled={!newGroupLabel.trim()}
                    onClick={addGroup}
                  >
                    Add group
                  </Button>
                </SpaceBetween>
              }
            >
              Custom groups
            </Header>
          }
        >
          {groups.filter((g) => !g.deleted).length === 0 ? (
            <Box color="text-body-secondary" padding="s">
              No custom groups yet. Create one above, then assign UT1 categories to it in the table below.
            </Box>
          ) : (
            <ColumnLayout columns={Math.min(3, groups.filter((g) => !g.deleted).length)} variant="text-grid">
              {groups.map((g, idx) =>
                g.deleted ? null : (
                  <SpaceBetween key={idx} size="xs" direction="horizontal">
                    <Box>
                      <Box>Label</Box>
                      <Input
                        value={g.label}
                        onChange={({ detail }) => updateGroup(idx, { label: detail.value })}
                      />
                    </Box>
                    <Box>
                      <Box>Hidden in analytics</Box>
                      <Toggle
                        checked={g.hidden}
                        onChange={({ detail }) => updateGroup(idx, { hidden: detail.checked })}
                      />
                    </Box>
                    <Box padding={{ top: "l" }}>
                      <Badge color={g.isNew ? "blue" : "grey"}>
                        {g.isNew ? "new" : `${ut1Cats.filter((c) => c.groupId === g.id).length} members`}
                      </Badge>
                    </Box>
                    <Box padding={{ top: "l" }}>
                      <Button variant="icon" iconName="close" onClick={() => deleteGroup(idx)} />
                    </Box>
                  </SpaceBetween>
                )
              )}
            </ColumnLayout>
          )}
        </Container>

        {/* ── UT1 categories table ──────────────────────────────────────── */}
        <Container
          header={
            <Header
              variant="h2"
              description="Each row is a UT1 category. Edit the label (display name), toggle it on/off, or assign it to a custom group."
              counter={`(${ut1Cats.length})`}
            >
              UT1 categories
            </Header>
          }
        >
          <SpaceBetween size="m">
            <TextFilter
              filteringText={filterText}
              onChange={({ detail }) => setFilterText(detail.filteringText)}
              filteringPlaceholder="Search by UT1 key, label or group…"
              countText={
                filterText
                  ? `${filtered.length} of ${ut1Cats.length} shown`
                  : undefined
              }
            />
            <div className="cat-manager-table">
            <Table
              items={filtered}
              loading={loading}
              loadingText="Loading categories…"
              variant="embedded"
              stickyHeader
              columnDefinitions={[
                {
                  id: "key",
                  header: "UT1 key",
                  width: 180,
                  cell: (r) => (
                    <Box>
                      <Box variant="code" fontSize="body-s">{r.key}</Box>
                    </Box>
                  ),
                },
                {
                  id: "label",
                  header: "Display label",
                  cell: (r) => (
                    <Input
                      value={r.label}
                      onChange={({ detail }) => updateCat(r.key, { label: detail.value })}
                      placeholder={humanize(r.key)}
                    />
                  ),
                },
                {
                  id: "description",
                  header: "Description",
                  cell: (r) => (
                    <Input
                      value={r.description}
                      onChange={({ detail }) => updateCat(r.key, { description: detail.value })}
                      placeholder="Optional description"
                    />
                  ),
                },
                {
                  id: "group",
                  header: "Group",
                  width: 200,
                  cell: (r) => {
                    const curOpt =
                      r.groupId !== null
                        ? groupOptions.find((o) => o.value === String(r.groupId))
                        : groupOptions[0];
                    const label = curOpt?.label ?? "— No group —";
                    return (
                      <div className="cat-manager-group-cell">
                        <ButtonDropdown
                          expandToViewport
                          variant="normal"
                          items={groupOptions.map((o) => ({ id: o.value, text: o.label }))}
                          onItemClick={({ detail }) => {
                            const val = detail.id;
                            if (val === NO_GROUP) {
                              updateCat(r.key, { groupId: null });
                            } else {
                              const numVal = Number(val);
                              if (!isNaN(numVal)) {
                                updateCat(r.key, { groupId: numVal });
                              }
                            }
                          }}
                        >
                          {label}
                        </ButtonDropdown>
                      </div>
                    );
                  },
                },
                {
                  id: "enabled",
                  header: "Enabled",
                  width: 110,
                  cell: (r) => (
                    <Toggle
                      checked={r.enabled}
                      onChange={({ detail }) => updateCat(r.key, { enabled: detail.checked })}
                    />
                  ),
                },
                {
                  id: "dirty",
                  header: "",
                  width: 56,
                  cell: (r) => (r.dirty ? <Badge color="blue">•</Badge> : null),
                },
              ]}
              empty={
                <Box color="text-body-secondary" textAlign="center">
                  {filterText ? "No categories match." : "No UT1 categories loaded yet — download the list first."}
                </Box>
              }
            />
            </div>
          </SpaceBetween>
        </Container>
      </SpaceBetween>
    </Modal>
  );
}
