import { useMemo, useState, type RefObject } from "react";
import { Search, X } from "lucide-react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vantyr/ui/components/dialog";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@vantyr/ui/components/input-group";
import { Spinner } from "@vantyr/ui/components/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@vantyr/ui/components/tabs";
import { HelpTip } from "@/components/common/HelpTip";
import type { Agent, AgentGroup } from "@/api/types";
import { cn } from "@/lib/utils";
import { plural } from "./groupSummary";
import { useMemberChanges } from "./useMemberChanges";

interface MembersModalProps {
  visible: boolean;
  onDismiss: () => void;
  group: AgentGroup | null;
  /** Device ids in the group; null until the first load finishes. */
  memberIds: string[] | null;
  /** A failed load or refresh of the member list. */
  loadError?: string | null;
  onRetry?: () => void;
  agentsList: Agent[];
  /** Each change is saved as soon as it succeeds; rejecting keeps the dialog's state and shows the failure in it. */
  onAddMembers: (agentIds: string[]) => Promise<void>;
  onRemoveMember: (agentId: string) => Promise<void>;
}

type Person = { id: string; name: string; known: boolean; duplicate: boolean };
type Tab = "members" | "add";

/** The search box only earns its space once a list is longer than this. */
const SEARCH_FROM = 6;
const NO_IDS: string[] = [];

export function MembersModal(props: MembersModalProps) {
  const { visible, onDismiss } = props;
  return (
    <Dialog open={visible} onOpenChange={(open) => !open && onDismiss()}>
      <DialogContent className="sm:max-w-lg">
        {/* Mounted only while open, so every visit starts on the right tab with nothing staged. */}
        {visible && props.group && <MembersBody {...props} group={props.group} />}
      </DialogContent>
    </Dialog>
  );
}

/** Split the fleet into this group's members and the devices that could still join, each sorted by name. */
function splitDevices(agentsList: Agent[], ids: string[]): { members: Person[]; available: Person[] } {
  const counts = new Map<string, number>();
  for (const a of agentsList) counts.set(a.name, (counts.get(a.name) ?? 0) + 1);
  const byId = new Map<string, Person>(
    agentsList.map((a) => [a.id, { id: a.id, name: a.name, known: true, duplicate: (counts.get(a.name) ?? 0) > 1 }]),
  );
  const inGroup = new Set(ids);
  const byName = (x: Person, y: Person) => x.name.localeCompare(y.name);
  return {
    members: ids.map((id) => byId.get(id) ?? { id, name: id, known: false, duplicate: false }).sort(byName),
    available: agentsList.filter((a) => !inGroup.has(a.id)).map((a) => byId.get(a.id)!).sort(byName),
  };
}

function MembersBody({
  onDismiss, group, memberIds, loadError, onRetry, agentsList, onAddMembers, onRemoveMember,
}: MembersModalProps & { group: AgentGroup }) {
  const [tab, setTab] = useState<Tab | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const { busy, failure, outcome, outcomeRef, run } = useMemberChanges();

  const ids = memberIds ?? NO_IDS;
  const { members, available } = useMemo(() => splitDevices(agentsList, ids), [agentsList, ids]);

  // Open on the members, or on adding when there is nobody to see yet, and stay on that tab while adding.
  if (tab === null && memberIds !== null) setTab(members.length === 0 ? "add" : "members");
  const activeTab: Tab = tab ?? "members";
  const needle = query.trim().toLowerCase();
  const matches = (p: Person) => !needle || p.name.toLowerCase().includes(needle) || p.id.toLowerCase().includes(needle);
  const shownMembers = members.filter(matches);
  const shownAvailable = available.filter(matches);
  const showSearch = (activeTab === "members" ? members : available).length >= SEARCH_FROM || needle !== "";

  // A staged device that was added elsewhere or no longer exists drops out of the selection.
  const chosen = selected.filter((id) => available.some((p) => p.id === id));

  const addChosen = () =>
    void run(async () => {
      await onAddMembers(chosen);
      setSelected([]);
    }, `Added ${plural(chosen.length, "device")} to ${group.name}.`);
  const remove = (person: Person) =>
    void run(() => onRemoveMember(person.id), `Removed ${person.known ? person.name : "the device"} from ${group.name}.`);
  const toggle = (id: string) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleShown = (on: boolean) =>
    setSelected((prev) => {
      const shown = new Set(shownAvailable.map((p) => p.id));
      const rest = prev.filter((id) => !shown.has(id));
      return on ? [...rest, ...shown] : rest;
    });
  const changeTab = (next: Tab) => {
    setTab(next);
    setQuery("");
  };

  const description = group.description?.trim();
  const error = failure ?? loadError ?? null;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="min-w-0 break-words pr-8">Members: {group.name}</DialogTitle>
        {description && <DialogDescription className="line-clamp-2">{description}</DialogDescription>}
      </DialogHeader>

      <MembersNotices error={error} canRetry={!failure && !!onRetry} onRetry={onRetry} outcome={outcome} outcomeRef={outcomeRef} />

      {memberIds === null ? (
        loadError ? null : (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Spinner /> Loading members…
        </div>
        )
      ) : (
        <Tabs value={activeTab} onValueChange={(value) => changeTab(value as Tab)} className="gap-3">
          <div className="flex items-center gap-1.5">
            <TabsList className="min-w-0 flex-1">
              <TabsTrigger value="members" className="pointer-coarse:h-9">In group ({members.length})</TabsTrigger>
              <TabsTrigger value="add" className="pointer-coarse:h-9">Add devices ({available.length})</TabsTrigger>
            </TabsList>
            <HelpTip>Devices in a group inherit the alert rules that target it. Changes are saved as soon as you remove a device or add your selection.</HelpTip>
          </div>
          {showSearch && <DeviceSearch query={query} onChange={setQuery} />}
          <TabsContent value="members">
            <MemberRows
              rows={shownMembers}
              searching={query.trim()}
              canAdd={available.length > 0}
              busy={busy}
              onRemove={remove}
              onClearSearch={() => setQuery("")}
              onAddDevices={() => changeTab("add")}
            />
          </TabsContent>
          <TabsContent value="add">
            <AvailableRows
              rows={shownAvailable}
              searching={query.trim()}
              noDevices={agentsList.length === 0}
              chosen={chosen}
              busy={busy}
              onToggle={toggle}
              onToggleShown={toggleShown}
              onClearSearch={() => setQuery("")}
            />
          </TabsContent>
        </Tabs>
      )}

      <MembersFooter
        count={chosen.length}
        busy={busy}
        onClear={() => setSelected([])}
        onAdd={addChosen}
        onDismiss={onDismiss}
      />
    </>
  );
}

function MembersNotices({ error, canRetry, onRetry, outcome, outcomeRef }: {
  error: string | null; canRetry: boolean; onRetry?: () => void; outcome: string | null; outcomeRef: RefObject<HTMLParagraphElement | null>;
}) {
  return (
    <>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 break-words">{error}</span>
            {canRetry && (
              <Button variant="outline" size="sm" onClick={onRetry}>
                Try again
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {outcome && (
        <p ref={outcomeRef} tabIndex={-1} role="status" className="text-sm text-success outline-none">
          {outcome}
        </p>
      )}
    </>
  );
}

function DeviceSearch({ query, onChange }: { query: string; onChange: (value: string) => void }) {
  return (
    <InputGroup className="h-9">
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
      <InputGroupInput
        aria-label="Search devices"
        placeholder="Search devices…"
        value={query}
        onChange={(event) => onChange(event.target.value)}
      />
      {query && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => onChange("")}>
            <X />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

function MemberRows({ rows, searching, canAdd, busy, onRemove, onClearSearch, onAddDevices }: {
  rows: Person[]; searching: string; canAdd: boolean; busy: boolean;
  onRemove: (person: Person) => void; onClearSearch: () => void; onAddDevices: () => void;
}) {
  if (rows.length === 0) {
    if (searching) return <ListEmpty text={`No members match “${searching}”.`} action={{ label: "Clear search", run: onClearSearch }} />;
    return <ListEmpty text="No devices are in this group yet." action={canAdd ? { label: "Add devices", run: onAddDevices } : undefined} />;
  }
  return (
    <ul aria-label="Devices in this group" className="max-h-[40dvh] overflow-y-auto rounded-lg border border-foreground/[0.08] md:max-h-[50dvh]">
      {rows.map((p) => (
        <li key={p.id} className="flex min-h-11 items-center gap-3 border-b border-foreground/[0.06] px-3 py-1.5 last:border-b-0">
          <DeviceName person={p} />
          <Button
            variant="ghost"
            size="sm"
            className="pointer-coarse:h-9"
            aria-label={`Remove ${p.name} from group`}
            disabled={busy}
            onClick={() => onRemove(p)}
          >
            Remove
          </Button>
        </li>
      ))}
    </ul>
  );
}

function AvailableRows({ rows, searching, noDevices, chosen, busy, onToggle, onToggleShown, onClearSearch }: {
  rows: Person[]; searching: string; noDevices: boolean; chosen: string[]; busy: boolean;
  onToggle: (id: string) => void; onToggleShown: (on: boolean) => void; onClearSearch: () => void;
}) {
  if (rows.length === 0) {
    if (searching) return <ListEmpty text={`No available devices match “${searching}”.`} action={{ label: "Clear search", run: onClearSearch }} />;
    return <ListEmpty text={noDevices ? "No devices are enrolled yet." : "Every device is already in this group."} />;
  }
  const chosenSet = new Set(chosen);
  const shownChosen = rows.filter((p) => chosenSet.has(p.id)).length;
  return (
    <div className="rounded-lg border border-foreground/[0.08]">
      <label className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-foreground/[0.06] bg-muted/40 px-3 text-xs text-muted-foreground">
        <Checkbox
          aria-label={searching ? "Select all shown devices" : "Select all devices"}
          checked={shownChosen === rows.length}
          indeterminate={shownChosen > 0 && shownChosen < rows.length}
          disabled={busy}
          onCheckedChange={(on) => onToggleShown(on)}
        />
        {searching ? `Select all ${rows.length} shown` : `Select all ${rows.length}`}
      </label>
      <ul aria-label="Devices you can add" className="max-h-[36dvh] overflow-y-auto md:max-h-[46dvh]">
        {rows.map((p) => (
          <li key={p.id} className="border-b border-foreground/[0.06] last:border-b-0">
            <label className={cn("flex min-h-11 cursor-pointer items-center gap-3 px-3 py-1.5", chosenSet.has(p.id) && "bg-primary/[0.06]")}>
              <Checkbox
                aria-label={`Add ${p.name}`}
                checked={chosenSet.has(p.id)}
                disabled={busy}
                onCheckedChange={() => onToggle(p.id)}
              />
              <DeviceName person={p} />
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The staged selection (not yet saved) with its confirm, beside Close. On a phone the confirm sits above Close. */
function MembersFooter({ count, busy, onClear, onAdd, onDismiss }: {
  count: number; busy: boolean; onClear: () => void; onAdd: () => void; onDismiss: () => void;
}) {
  return (
    <DialogFooter className="flex-col sm:flex-row sm:items-center">
      {count > 0 && (
        <div className="order-1 flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm whitespace-nowrap">
            {count} selected <span className="text-muted-foreground">· not added yet</span>
          </span>
          <Button variant="ghost" size="sm" className="pointer-coarse:h-9" disabled={busy} onClick={onClear}>
            Clear
          </Button>
        </div>
      )}
      <Button variant="outline" className="order-3 sm:order-2" disabled={busy} onClick={onDismiss}>
        {count > 0 ? "Discard" : "Close"}
      </Button>
      {count > 0 && (
        <Button className="order-2 sm:order-3" disabled={busy} onClick={onAdd}>
          {busy && <Spinner />} Add {plural(count, "device")}
        </Button>
      )}
    </DialogFooter>
  );
}

function DeviceName({ person }: { person: Person }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-medium">{person.known ? person.name : "Unknown device"}</p>
      {(person.duplicate || !person.known) && (
        <p className="truncate font-mono text-xs text-muted-foreground">{person.id.slice(0, 8)}…</p>
      )}
    </div>
  );
}

function ListEmpty({ text, action }: { text: string; action?: { label: string; run: () => void } }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-foreground/[0.12] px-4 py-8 text-center text-sm text-muted-foreground">
      <p>{text}</p>
      {action && (
        <Button variant="outline" size="sm" className="pointer-coarse:h-9" onClick={action.run}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
