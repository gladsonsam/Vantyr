import { useEffect, useRef, useState } from "react";
import { ArrowDownUp, Bookmark, BookmarkPlus, LayoutGrid, List, Search, Star, Trash2, X } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vantyr/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@vantyr/ui/components/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "@vantyr/ui/components/field";
import { Input } from "@vantyr/ui/components/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@vantyr/ui/components/input-group";
import { Tabs, TabsList, TabsTrigger } from "@vantyr/ui/components/tabs";
import { Toggle } from "@vantyr/ui/components/toggle";
import { ToggleGroup, ToggleGroupItem } from "@vantyr/ui/components/toggle-group";
import type { FleetPreferences, FleetStatusFilter, SavedFleetView } from "@/features/fleet/lib/fleetPreferences";
import type { FleetSort } from "@/features/fleet/lib/fleetSort";

const SORT_LABELS: Record<FleetSort["key"], string> = {
  connectivity: "Connectivity",
  name: "Name",
  last_seen: "Last seen",
  first_seen: "Date added",
  agent_version: "Agent version",
};

function directionLabel(key: FleetSort["key"], direction: FleetSort["direction"]) {
  if (key === "connectivity") return direction === "asc" ? "Online first" : "Offline first";
  if (key === "last_seen" || key === "first_seen") return direction === "asc" ? "Oldest first" : "Newest first";
  if (key === "agent_version") return direction === "asc" ? "Lowest first" : "Highest first";
  return direction === "asc" ? "A–Z" : "Z–A";
}

export type StatusCounts = Record<FleetStatusFilter, number>;

interface Props {
  current: Omit<SavedFleetView, "name">;
  counts: StatusCounts;
  preferences: FleetPreferences;
  ready: boolean;
  onSearch: (value: string) => void;
  onStatus: (value: FleetStatusFilter) => void;
  onView: (value: "grid" | "table") => void;
  onSort: (value: FleetSort) => void;
  onFavoritesOnly: (value: boolean) => void;
  onApply: (view: SavedFleetView) => void;
  onSave: (name: string) => void;
  onRemove: (name: string) => void;
  onClear: () => void;
}

const STATUS_TABS: { value: FleetStatusFilter; label: string; hint?: string }[] = [
  { value: "all", label: "All" },
  { value: "online", label: "Online", hint: "Connected devices, including those with no activity data" },
  { value: "active", label: "Active" },
  { value: "afk", label: "Away" },
  { value: "offline", label: "Offline" },
];

export function FleetToolbar({ current, counts, preferences, ready, onSearch, onStatus, onView, onSort, onFavoritesOnly, onApply, onSave, onRemove, onClear }: Props) {
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const tabsScroller = useRef<HTMLDivElement>(null);
  const filtered = Boolean(current.search.trim() || current.status !== "all" || current.favoritesOnly);
  const trimmed = name.trim();
  const full = preferences.views.length >= 20 && !preferences.views.some((view) => view.name === trimmed);
  const canSave = ready && Boolean(trimmed) && !full && current.search.length <= 512;

  useEffect(() => {
    tabsScroller.current?.querySelector<HTMLElement>("[data-active]")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [current.status]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end gap-4 border-b border-foreground/[0.06]">
        <div ref={tabsScroller} className="-mb-px min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] max-sm:[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] [&::-webkit-scrollbar]:hidden">
          <Tabs value={current.status} onValueChange={(value) => onStatus(value as FleetStatusFilter)}>
            <TabsList variant="line" aria-label="Device status" className="h-11! w-max gap-2 p-0">
              {STATUS_TABS.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value} title={tab.hint} className="h-full! flex-none gap-2 px-2.5 after:bottom-0!">
                  {tab.label}
                  <span className="text-xs text-muted-foreground tabular-nums">{counts[tab.value]}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        {/* The table never renders on phones (FleetOverview forces the grid there),
            so the view switch is dead UI below sm — hide it and give the tabs room. */}
        <div className="hidden shrink-0 pb-1.5 sm:block">
          <ToggleGroup
            size="sm"
            spacing={0}
            className="rounded-lg bg-muted/70 p-0.5"
            aria-label="Fleet view mode"
            value={[current.view]}
            onValueChange={(value) => {
              const next = value[0] as "grid" | "table" | undefined;
              if (next) onView(next);
            }}
          >
            <ToggleGroupItem value="grid" aria-label="Grid view" className="rounded-md! aria-pressed:bg-background">
              <LayoutGrid />
            </ToggleGroupItem>
            <ToggleGroupItem value="table" aria-label="List view" className="rounded-md! aria-pressed:bg-background">
              <List />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="h-9 min-w-0 basis-full sm:flex-1 sm:basis-0 sm:max-w-md">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search fleet devices"
            placeholder="Search devices…"
            maxLength={512}
            value={current.search}
            onChange={(event) => onSearch(event.target.value)}
          />
          {current.search && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => onSearch("")}>
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>

        <div className="flex flex-wrap items-center gap-2 sm:ml-auto sm:shrink-0">
          {filtered && (
            <Button variant="ghost" size="default" aria-label="Clear filters" title="Clear filters" onClick={onClear}>
              <X />
              <span className="hidden sm:inline">Clear filters</span>
            </Button>
          )}
          <Toggle
            variant="outline"
            size="default"
            aria-label="Favorites only"
            title="Show favorites only"
            pressed={current.favoritesOnly}
            disabled={!ready}
            onPressedChange={onFavoritesOnly}
            className="aria-pressed:text-warning"
          >
            <Star fill={current.favoritesOnly ? "currentColor" : "none"} />
            <span>Favorites</span>
          </Toggle>

          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="default" aria-label="Sort devices" title="Sort devices" />}>
              <ArrowDownUp />
              <span>{SORT_LABELS[current.sort.key]}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={current.sort.key} onValueChange={(key) => onSort({ ...current.sort, key: key as FleetSort["key"] })}>
                  {(Object.keys(SORT_LABELS) as FleetSort["key"][]).map((key) => (
                    <DropdownMenuRadioItem key={key} value={key}>
                      {SORT_LABELS[key]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Order</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={current.sort.direction}
                  onValueChange={(direction) => onSort({ ...current.sort, direction: direction as FleetSort["direction"] })}
                >
                  {(["asc", "desc"] as const).map((direction) => (
                    <DropdownMenuRadioItem key={direction} value={direction}>
                      {directionLabel(current.sort.key, direction)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="default" title="Saved views" disabled={!ready} />}>
              <Bookmark />
              <span>Views</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Saved views</DropdownMenuLabel>
                {preferences.views.length === 0 ? (
                  <div className="px-1.5 py-1 text-xs text-muted-foreground">No saved views yet.</div>
                ) : (
                  preferences.views.map((view) => (
                    <DropdownMenuItem key={view.name} onClick={() => onApply(view)}>
                      <Bookmark /> <span className="truncate">{view.name}</span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setSaveOpen(true)}>
                <BookmarkPlus /> Save current view…
              </DropdownMenuItem>
              {preferences.views.length > 0 && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Trash2 /> Remove a view
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {preferences.views.map((view) => (
                      <DropdownMenuItem key={view.name} variant="destructive" onClick={() => onRemove(view.name)}>
                        {view.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              <DropdownMenuSeparator />
              <p className="px-1.5 py-1 text-[11px] leading-snug text-muted-foreground">
                Stored in this browser for your account on this server. Up to 20 views.
              </p>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canSave) return;
              onSave(trimmed);
              setName("");
              setSaveOpen(false);
            }}
          >
            <DialogHeader>
              <DialogTitle>Save view</DialogTitle>
              <DialogDescription>Saves the current search, status, favorites, sort and layout.</DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor="fleet-view-name">View name</FieldLabel>
              <Input id="fleet-view-name" autoFocus maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
              <FieldDescription>{full ? "You already have 20 views. Remove one first." : "Saving an existing name replaces that view."}</FieldDescription>
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSaveOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canSave}>
                Save view
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
