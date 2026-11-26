import { useMemo, useState } from "react";
import { Plus, Search, SearchX, Users, X } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@vantyr/ui/components/input-group";
import { Spinner } from "@vantyr/ui/components/spinner";
import type { AgentGroup } from "@/api/types";
import { EmptyState } from "@/components/common/EmptyState";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import { GroupList, type GroupAction } from "./GroupList";

/** The search box appears once there are enough groups for it to help. */
const SEARCH_FROM = 6;

interface GroupsContentProps {
  groups: AgentGroup[];
  /** The first load is still running. */
  loading: boolean;
  /** The list failed to load and there is nothing older to show. */
  loadError: string | null;
  onRetry: () => void;
  ruleCounts: Map<string, number> | null;
  onCreate: () => void;
  onAction: (group: AgentGroup, action: GroupAction) => void;
}

/** Whichever of loading, failed, empty, no-match or the list applies. */
export function GroupsContent({
  groups,
  loading,
  loadError,
  onRetry,
  ruleCounts,
  onCreate,
  onAction,
}: GroupsContentProps) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const shown = useMemo(
    () =>
      needle
        ? groups.filter(
            (g) =>
              g.name.toLowerCase().includes(needle) || g.description.toLowerCase().includes(needle),
          )
        : groups,
    [groups, needle],
  );

  if (loadError)
    return <LoadFailedCard message={`Couldn’t load groups: ${loadError}`} onRetry={onRetry} />;
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl bg-card py-12 text-sm text-muted-foreground">
        <Spinner /> Loading groups…
      </div>
    );
  }
  if (groups.length === 0) {
    return (
      <EmptyState
        title="No groups yet"
        description="Create a group to apply the same rules to several devices."
        icon={<Users />}
        iconVariant="icon"
        action={
          <Button onClick={onCreate}>
            <Plus /> Create group
          </Button>
        }
      />
    );
  }
  return (
    <>
      {(groups.length >= SEARCH_FROM || needle) && (
        <InputGroup className="h-9 sm:max-w-md">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search groups"
            placeholder="Search groups…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {search && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label="Clear search"
                onClick={() => setSearch("")}
              >
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
      )}
      {shown.length === 0 ? (
        <EmptyState
          title={`No groups match “${search.trim()}”`}
          icon={<SearchX />}
          iconVariant="icon"
          action={
            <Button variant="outline" onClick={() => setSearch("")}>
              Clear search
            </Button>
          }
        />
      ) : (
        <GroupList groups={shown} ruleCounts={ruleCounts} onAction={onAction} />
      )}
    </>
  );
}
