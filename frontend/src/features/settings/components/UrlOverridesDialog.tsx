import { useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Trash2, X } from "lucide-react";
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
import {
  urlCategoryKeys,
  urlCategoryQueries,
  useDeleteUrlOverrideMutation,
  useRecalcUrlSessionsMutation,
  useRecalcUrlVisitsMutation,
  useUpsertUrlOverrideMutation,
} from "@/api/queries/urlCategories";
import { humanize } from "../lib/categoryDraft";

type UrlOverrideRow = { id: number; kind: "domain" | "url"; value: string; category_key: string; category_label: string; note: string; created_at: string };
const NO_OVERRIDES: UrlOverrideRow[] = [];
const NO_CATEGORIES: { key: string; label?: string; enabled: boolean; description: string }[] = [];

/** Manage the admin domain / URL-prefix category overrides. */
export function UrlOverridesDialog({ open, isAdmin, onClose }: { open: boolean; isAdmin: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [addKind, setAddKind] = useState<"domain" | "url">("domain");
  const [addValue, setAddValue] = useState("");
  const [addCategory, setAddCategory] = useState("");
  const [addNote, setAddNote] = useState("");
  const [addSaving, setAddSaving] = useState(false);

  const upsert = useUpsertUrlOverrideMutation();
  const deleteOverride = useDeleteUrlOverrideMutation();
  const recalcVisits = useRecalcUrlVisitsMutation();
  const recalcSessions = useRecalcUrlSessionsMutation();

  // Loaded while the dialog is open; typing in the search box re-keys the list (keeping the
  // previous rows up until the new ones arrive).
  const overridesQuery = useQuery({
    ...urlCategoryQueries.overrides(search),
    enabled: open && isAdmin,
    placeholderData: keepPreviousData,
  });
  const rows = overridesQuery.isError ? NO_OVERRIDES : overridesQuery.data?.rows ?? NO_OVERRIDES;
  const loading = overridesQuery.isFetching;
  const error = actionError ?? (overridesQuery.error ? String(overridesQuery.error) : null);
  const fetchOverrides = async () => {
    setActionError(null);
    await queryClient.invalidateQueries({ queryKey: urlCategoryKeys.overrides(search) });
  };

  const categoriesQuery = useQuery({ ...urlCategoryQueries.categories(), enabled: open && isAdmin });
  const categories = categoriesQuery.isError ? NO_CATEGORIES : categoriesQuery.data?.categories ?? NO_CATEGORIES;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>URL category overrides</DialogTitle>
          <DialogDescription>
            Overrides apply before UT1 lists and persist across updates. Use domain overrides for hostnames (recommended) and URL overrides for specific prefixes.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="override-kind">Override type</FieldLabel>
              <Select value={addKind} onValueChange={(value) => value && setAddKind(value as "domain" | "url")}>
                <SelectTrigger id="override-kind" className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="domain">Domain</SelectItem>
                  <SelectItem value="url">URL prefix</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="override-category">Category</FieldLabel>
              <Select value={addCategory} onValueChange={(value) => setAddCategory(value ?? "")}>
                <SelectTrigger id="override-category" className="h-9 w-full">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {categories
                    .filter((c) => c.enabled)
                    .map((c) => {
                      const key = c.key ?? "";
                      return (
                        <SelectItem key={key} value={key}>
                          {(c.label ?? "").trim() || humanize(key) || key}
                        </SelectItem>
                      );
                    })}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="override-value">{addKind === "domain" ? "Domain" : "URL prefix"}</FieldLabel>
            <Input
              id="override-value"
              value={addValue}
              onChange={(event) => setAddValue(event.target.value)}
              placeholder={addKind === "domain" ? "example.com" : "https://example.com/path"}
              className="h-9"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="override-note">Note (optional)</FieldLabel>
            <Input id="override-note" value={addNote} onChange={(event) => setAddNote(event.target.value)} className="h-9" />
          </Field>
          <div>
            <Button
              disabled={addSaving || !addValue.trim() || !addCategory.trim()}
              onClick={async () => {
                setAddSaving(true);
                try {
                  await upsert.mutateAsync({ kind: addKind, value: addValue, category_key: addCategory, note: addNote });
                  setAddValue("");
                  setAddNote("");
                  await fetchOverrides();
                } catch (e) {
                  setActionError(String(e));
                } finally {
                  setAddSaving(false);
                }
              }}
            >
              {addSaving && <Spinner />} Add / update override
            </Button>
          </div>

          <div className="flex flex-col gap-1">
            <InputGroup className="h-9">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="Search overrides"
                placeholder="Search overrides (domain/url/category)"
                value={search}
                onChange={(event) => {
                  setActionError(null);
                  setSearch(event.target.value);
                }}
              />
              {search && (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-xs"
                    aria-label="Clear search"
                    onClick={() => {
                      setActionError(null);
                      setSearch("");
                    }}
                  >
                    <X />
                  </InputGroupButton>
                </InputGroupAddon>
              )}
            </InputGroup>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  await recalcVisits.mutateAsync();
                } catch (e) {
                  setActionError(String(e));
                }
              }}
            >
              Re-categorize URL visits
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  await recalcSessions.mutateAsync();
                } catch (e) {
                  setActionError(String(e));
                }
              }}
            >
              Re-categorize URL sessions
            </Button>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-3">Type</TableHead>
                <TableHead className="px-3">Value</TableHead>
                <TableHead className="px-3">Category</TableHead>
                <TableHead className="px-3">Note</TableHead>
                <TableHead className="px-3">Created</TableHead>
                <TableHead className="px-3"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    <span className="inline-flex items-center gap-2"><Spinner /> Loading…</span>
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    No overrides yet.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={`${r.kind}-${r.id}`}>
                    <TableCell className="px-3 py-3.5">{r.kind}</TableCell>
                    <TableCell className="px-3 py-3.5 break-all">{r.value}</TableCell>
                    <TableCell className="px-3 py-3.5">{r.category_label || r.category_key}</TableCell>
                    <TableCell className="px-3 py-3.5">{r.note || "—"}</TableCell>
                    <TableCell className="px-3 py-3.5">{new Date(r.created_at).toLocaleString()}</TableCell>
                    <TableCell className="px-3 py-3.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete override for ${r.value}`}
                        onClick={async () => {
                          try {
                            await deleteOverride.mutateAsync({ kind: r.kind, id: r.id });
                            await fetchOverrides();
                          } catch (e) {
                            setActionError(String(e));
                          }
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
